import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Id, PrinterFiles, RemoteFileRef } from '@orca/platform-contract';
import { DownloadExecutor } from './downloadExecutor';
import { createDownloadFileSink, openDownloadJournal } from './downloadFiles';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), 'neo-executor-')); roots.push(path); return path; }
const file: RemoteFileRef = { printerId: 'printer' as Id<'printer'>, routeId: 'lan' as Id<'route'>,
  configurationRevision: 'config', storageId: 'sd' as Id<'storage'>, fileId: 'file' as Id<'remote-file'> };
function reader(chunks: AsyncIterable<Uint8Array> = { async *[Symbol.asyncIterator]() { yield new Uint8Array([1, 2, 3]); } }) {
  return vi.fn<PrinterFiles['download']>(async ({ target }) => ({ ok: true, value: {
    file: target, mimeType: null, suggestedFileName: 'actual.mp4', totalBytes: 3, responseBytes: 3, returnedRange: null, chunks,
  } }));
}
it('captures the source/destination at admission and publishes the agent filename with progress', async () => {
  const path = await root(), read = reader(), progress = vi.fn(), executor = new DownloadExecutor(read, 4, progress);
  const initialization = executor.initialize(join(path, 'journal'), process.pid);
  const selected = { ...file }, destination = { kind: 'directory' as const, directory: join(path, 'saved') };
  const task = executor.run('first', selected, destination);
  selected.fileId = 'other' as Id<'remote-file'>; destination.directory = join(path, 'other');
  await initialization;
  const result = await task;
  expect(result).toMatchObject({ status: 'saved', writtenBytes: 3, value: { path: join(path, 'saved/actual.mp4') } });
  expect(await readFile(join(path, 'saved/actual.mp4'))).toEqual(Buffer.from([1, 2, 3]));
  expect(read.mock.calls[0][0].target).toEqual(file);
  expect(progress.mock.calls.at(-1)).toEqual(['first', { phase: 'finalizing', writtenBytes: 3, totalBytes: 3, canCancel: false }]);
  await executor.close(); expect(await readdir(join(path, 'journal'))).toEqual([]);
});
it('honors cancellation arriving before execution without opening a reader or output', async () => {
  const path = await root(), read = reader(), executor = new DownloadExecutor(read, 4, () => {});
  await executor.initialize(join(path, 'journal'), process.pid); executor.cancel('early');
  expect(await executor.run('early', file, { kind: 'directory', directory: path })).toEqual({ status: 'cancelled', writtenBytes: 0 });
  expect(read).not.toHaveBeenCalled(); await executor.close(); expect(await readdir(path)).toEqual(['journal']);
});
it('joins a cancelled stalled source and cleans its partial file before shutdown returns', async () => {
  const path = await root(); let started!: () => void, released = false;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const read: PrinterFiles['download'] = async ({ target }, options) => ({ ok: true, value: {
    file: target, mimeType: null, suggestedFileName: 'partial.mp4', totalBytes: 3, responseBytes: 3, returnedRange: null,
    chunks: { async *[Symbol.asyncIterator]() { try {
      yield new Uint8Array([1]); started();
      await new Promise<void>(resolve => { if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener('abort', () => resolve(), { once: true }); });
      throw new Error('interrupted');
    } finally { released = true; } } },
  } });
  const executor = new DownloadExecutor(read, 4, () => {});
  await executor.initialize(join(path, 'journal'), process.pid);
  const task = executor.run('active', file, { kind: 'directory', directory: join(path, 'saved') });
  await entered; await executor.close();
  expect(await task).toMatchObject({ status: 'cancelled', writtenBytes: 1 }); expect(released).toBe(true);
  expect(await readdir(join(path, 'saved'))).toEqual([]); expect(await readdir(join(path, 'journal'))).toEqual([]);
});
it('does not scavenge a live owner and recovers its orphan after both owners exit', async () => {
  const path = await root(), journalRoot = join(path, 'journal');
  const old = await openDownloadJournal(journalRoot, 12345, () => false);
  const sink = await createDownloadFileSink({ kind: 'directory', directory: path, fileName: 'video.mp4' }, old.directory);
  await sink.write(new Uint8Array([1]));
  const live = await openDownloadJournal(journalRoot, process.pid, pid => pid === 12345);
  expect(live.recovery.cleaned).toBe(0); expect((await readdir(old.directory)).length).toBe(1); await live.close();
  // Close the descriptor as if the old process exited, while preserving its journal-owned partial file.
  // A separate fixture record avoids holding an open handle during Windows cleanup.
  const record = JSON.parse(await readFile(join(old.directory, (await readdir(old.directory))[0]), 'utf8'));
  await sink.discard(); await writeFile(record.temporary, 'orphan');
  await writeFile(join(old.directory, `${record.id}.json`), JSON.stringify(record));
  const recovered = await openDownloadJournal(journalRoot, process.pid, () => false);
  expect(recovered.recovery).toEqual({ cleaned: 1, failed: 0, ignored: 0 });
  expect(await readdir(path)).toEqual(['journal']); await recovered.close();
});
it('retains failed records on close and ignores invalid owner metadata', async () => {
  const path = await root(), journalRoot = join(path, 'journal');
  const old = await openDownloadJournal(journalRoot, process.pid, () => false);
  await writeFile(join(old.directory, 'unknown'), 'not a cleanup instruction'); await old.close();
  expect(await readdir(old.directory)).toEqual(['unknown']);
  await writeFile(join(dirname(old.directory), 'owner.json'), JSON.stringify({ parentPid: -1, workerPid: 0 }));
  const current = await openDownloadJournal(journalRoot, process.pid, () => false);
  expect(current.recovery.ignored).toBe(1); expect(await readdir(old.directory)).toEqual(['unknown']); await current.close();
});
