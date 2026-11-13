import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { executeDownload } from '@orca/printer-control/downloads';
import type { Id, RemoteFileRef } from '@orca/platform-contract';
import { createDownloadFileSink, recoverInterruptedDownloads } from './downloadFiles';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'neo-download-')); roots.push(root);
  const directory = join(root, 'saved'), journal = join(root, 'journal');
  await mkdir(directory);
  const sink = (name = 'model.gcode.3mf') => createDownloadFileSink({ kind: 'directory', directory, fileName: name }, journal);
  return { root, directory, journal, sink };
}

describe('utility download files', () => {
  it('keeps an existing destination unchanged until a complete replacement is published', async () => {
    const f = await fixture(), path = join(f.directory, 'model.3mf');
    await writeFile(path, 'original');
    const sink = await createDownloadFileSink({ kind: 'file', path, overwriteConfirmed: true }, f.journal);
    await sink.write(new TextEncoder().encode('replacement'));
    expect(await readFile(path, 'utf8')).toBe('original');
    expect(await sink.publish()).toEqual({ path, fileName: 'model.3mf', cleanupPending: false });
    expect(await readFile(path, 'utf8')).toBe('replacement');
    expect(await readdir(f.directory)).toEqual(['model.3mf']);
    expect(await readdir(f.journal)).toEqual([]);
    await sink.discard(); // Cleanup must never remove a published file.
    expect(await readFile(path, 'utf8')).toBe('replacement');
  });

  it('publishes concurrent same-name downloads without replacing any result', async () => {
    const f = await fixture();
    await writeFile(join(f.directory, 'model.gcode.3mf'), 'original');
    const saved = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const sink = await f.sink(); await sink.write(new Uint8Array([index])); return sink.publish();
    }));
    expect(new Set(saved.map(file => file.path)).size).toBe(8);
    expect(saved.every(file => /^model \([1-8]\)\.gcode\.3mf$/.test(file.fileName))).toBe(true);
    expect(await Promise.all(saved.map(file => readFile(file.path).then(bytes => bytes[0])))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(await readFile(join(f.directory, 'model.gcode.3mf'), 'utf8')).toBe('original');
    expect(await readdir(f.journal)).toEqual([]);
  });

  it('rejects a late Save As collision without overwriting it', async () => {
    const f = await fixture(), path = join(f.directory, 'video.mp4');
    const sink = await createDownloadFileSink({ kind: 'file', path, overwriteConfirmed: false }, f.journal);
    await sink.write(new Uint8Array([1, 2, 3])); await writeFile(path, 'arrived-later');
    await expect(sink.publish()).rejects.toThrow('confirm replacement');
    await sink.discard();
    expect(await readFile(path, 'utf8')).toBe('arrived-later');
    expect(await readdir(f.directory)).toEqual(['video.mp4']);
    expect(await readdir(f.journal)).toEqual([]);
  });

  it('cleans an unpublished partial file without touching another download or the target', async () => {
    const f = await fixture();
    await writeFile(join(f.directory, 'model.gcode.3mf'), 'original');
    const first = await f.sink(), second = await f.sink();
    await first.write(new Uint8Array([1])); await second.write(new Uint8Array([2]));
    await first.discard(); await first.discard();
    expect((await readdir(f.journal)).length).toBe(1);
    const saved = await second.publish();
    expect(await readFile(saved.path)).toEqual(Buffer.from([2]));
    expect(await readFile(join(f.directory, 'model.gcode.3mf'), 'utf8')).toBe('original');
  });

  it.each(['../outside', '/absolute', 'a\\b', '..', 'bad\0name', 'CON', 'bad:name', 'trailing.'])('rejects unsafe filename %j without creating output', async name => {
    const f = await fixture();
    await expect(f.sink(name)).rejects.toThrow('filename');
    expect(await readdir(f.directory)).toEqual([]);
  });

  it('recovers only journal-owned temporary files after a writer process exits', async () => {
    const f = await fixture();
    const moduleUrl = pathToFileURL(join(__dirname, 'downloadFiles.ts')).href;
    const source = `import { createDownloadFileSink } from ${JSON.stringify(moduleUrl)};
      const sink = await createDownloadFileSink(${JSON.stringify({ kind: 'directory', directory: f.directory, fileName: 'video.mp4' })}, ${JSON.stringify(f.journal)});
      await sink.write(new Uint8Array([1, 2, 3])); process.exit(0);`;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source]);
    const unrelated = `.orca-download-${randomUUID()}.part`;
    await writeFile(join(f.directory, unrelated), 'not-owned');
    expect((await readdir(f.journal)).length).toBe(1);
    expect(await recoverInterruptedDownloads(f.journal)).toEqual({ cleaned: 1, failed: 0, ignored: 0 });
    expect(await readdir(f.directory)).toEqual([unrelated]);
    expect(await readFile(join(f.directory, unrelated), 'utf8')).toBe('not-owned');
  });

  it('does not interpret malformed recovery records as arbitrary deletion requests', async () => {
    const f = await fixture(), id = randomUUID();
    await mkdir(f.journal); const innocent = join(f.directory, 'important.3mf'); await writeFile(innocent, 'keep');
    await writeFile(join(f.journal, `${id}.json`), JSON.stringify({ id, temporary: innocent }));
    await writeFile(join(f.journal, 'unrelated.json'), '{}');
    expect(await recoverInterruptedDownloads(f.journal)).toEqual({ cleaned: 0, failed: 0, ignored: 2 });
    expect(await readFile(innocent, 'utf8')).toBe('keep');
  });

  it('integrates terminal reader validation with actual filesystem cleanup', async () => {
    const f = await fixture();
    const file: RemoteFileRef = { printerId: 'p' as Id<'printer'>, routeId: 'r' as Id<'route'>,
      configurationRevision: 'c', storageId: 's' as Id<'storage'>, fileId: 'f' as Id<'remote-file'> };
    const result = await executeDownload(file, {
      maxChunkBytes: 1024,
      read: async () => ({ ok: true, value: { file, suggestedFileName: 'video.mp4', mimeType: null,
        totalBytes: 3, responseBytes: 3, returnedRange: null,
        chunks: (async function* () { yield new Uint8Array([1, 2, 3]); throw new Error('checksum failed'); })() } }),
      createSink: metadata => f.sink(metadata.suggestedFileName),
    });
    expect(result).toMatchObject({ status: 'failed', writtenBytes: 3, failure: { stage: 'read' } });
    expect(await readdir(f.directory)).toEqual([]); expect(await readdir(f.journal)).toEqual([]);
  });
});
