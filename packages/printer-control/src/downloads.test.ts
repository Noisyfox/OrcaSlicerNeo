import { describe, expect, it, vi } from 'vitest';
import { executeDownload } from './downloads';
import type { DownloadExecution, DownloadProgress, DownloadedFile, Id, PrinterFiles, RemoteFileRef } from '@orca/platform-contract';

const file: RemoteFileRef = { printerId: 'printer' as Id<'printer'>, routeId: 'lan' as Id<'route'>,
  configurationRevision: 'config', storageId: 'sd' as Id<'storage'>, fileId: 'file' as Id<'remote-file'> };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const signal = new AbortController();
  const writes: number[][] = [], progress: DownloadProgress[] = [];
  const release = vi.fn(async () => ({ done: true as const, value: undefined }));
  const next = vi.fn<AsyncIterator<Uint8Array>['next']>()
    .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2]) })
    .mockResolvedValueOnce({ done: false, value: new Uint8Array([3]) })
    .mockResolvedValue({ done: true, value: undefined });
  const data: DownloadedFile = { file, mimeType: null, suggestedFileName: 'part.3mf', totalBytes: 3,
    responseBytes: 3, returnedRange: null, chunks: { [Symbol.asyncIterator]: () => ({ next, return: release }) } };
  const sink = {
    write: vi.fn(async (chunk: Uint8Array) => { writes.push([...chunk]); }),
    publish: vi.fn(async () => 'saved-file-token'), discard: vi.fn(async () => {}),
  };
  const read = vi.fn<PrinterFiles['download']>(async () => ({ ok: true, value: data }));
  const createSink = vi.fn(async () => sink);
  const execution: DownloadExecution<string> = { read, createSink, maxChunkBytes: 4 };
  const run = () => executeDownload(file, execution, { signal: signal.signal, progress: value => progress.push(value) });
  return { signal, progress, writes, release, next, data, sink, read, createSink, execution, run };
}

describe('managed streaming download', () => {
  it('waits for each write, terminal reader validation and close before publishing', async () => {
    const f = fixture(), writing = deferred<void>(), entered = deferred<void>();
    f.sink.write.mockImplementationOnce(async chunk => { f.writes.push([...chunk]); entered.resolve(); await writing.promise; });
    const task = f.run();
    await entered.promise;
    expect(f.next).toHaveBeenCalledTimes(1);
    expect(f.sink.publish).not.toHaveBeenCalled();
    writing.resolve();
    expect(await task).toEqual({ status: 'saved', value: 'saved-file-token', writtenBytes: 3 });
    expect(f.writes).toEqual([[1, 2], [3]]);
    expect(f.next).toHaveBeenCalledTimes(3);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.release.mock.invocationCallOrder[0]).toBeLessThan(f.sink.publish.mock.invocationCallOrder[0]);
    expect(f.progress.at(-1)).toEqual({ phase: 'finalizing', writtenBytes: 3, totalBytes: 3, canCancel: false });
    expect(f.sink.discard).not.toHaveBeenCalled();
    expect(f.read.mock.calls[0][0]).toEqual({ target: file });
    expect(f.createSink.mock.calls[0]).toEqual([{ suggestedFileName: 'part.3mf', mimeType: null, totalBytes: 3 }]);
  });

  it('does not open a reader or destination after cancellation before admission', async () => {
    const f = fixture(); f.signal.abort();
    expect(await f.run()).toEqual({ status: 'cancelled', writtenBytes: 0 });
    expect(f.read).not.toHaveBeenCalled(); expect(f.createSink).not.toHaveBeenCalled();
  });

  it('retains the admitted source when the caller changes its active file selection', async () => {
    const f = fixture(), opening = deferred<void>(), entered = deferred<void>(), selected = { ...file };
    f.read.mockImplementation(async () => { entered.resolve(); await opening.promise; return { ok: true, value: f.data }; });
    const task = executeDownload(selected, f.execution);
    await entered.promise; selected.fileId = 'other-file' as Id<'remote-file'>; opening.resolve();
    expect(await task).toMatchObject({ status: 'saved', writtenBytes: 3 });
    expect(f.read.mock.calls[0][0].target).toEqual(file);
  });

  it('cancels a stalled read through its signal and joins reader and sink cleanup', async () => {
    const f = fixture(), entered = deferred<void>();
    f.read.mockImplementation(async (_request, options) => {
      f.next.mockReset().mockImplementation(() => new Promise((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(new Error('Native read aborted')), { once: true });
        entered.resolve();
      }));
      return { ok: true, value: f.data };
    });
    const task = f.run(); await entered.promise; f.signal.abort();
    expect(await task).toEqual({ status: 'cancelled', writtenBytes: 0 });
    expect(f.release).toHaveBeenCalledOnce(); expect(f.sink.discard).toHaveBeenCalledOnce();
    expect(f.sink.publish).not.toHaveBeenCalled();
  });

  it('settles an outstanding write before cancellation discards the destination', async () => {
    const f = fixture(), writing = deferred<void>(), entered = deferred<void>();
    f.sink.write.mockImplementationOnce(async () => { entered.resolve(); await writing.promise; });
    const task = f.run(); await entered.promise; f.signal.abort();
    expect(f.sink.discard).not.toHaveBeenCalled();
    writing.resolve();
    expect(await task).toEqual({ status: 'cancelled', writtenBytes: 2 });
    expect(f.next).toHaveBeenCalledTimes(1); expect(f.sink.discard).toHaveBeenCalledOnce();
    expect(f.sink.publish).not.toHaveBeenCalled();
  });

  it('releases a reader that finishes opening after cancellation without creating a destination', async () => {
    const f = fixture(), opening = deferred<void>(), entered = deferred<void>();
    f.read.mockImplementation(async () => { entered.resolve(); await opening.promise; return { ok: true, value: f.data }; });
    const task = f.run(); await entered.promise; f.signal.abort(); opening.resolve();
    expect(await task).toEqual({ status: 'cancelled', writtenBytes: 0 });
    expect(f.createSink).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
  });

  it('releases a reader when opening the destination fails', async () => {
    const f = fixture(); f.createSink.mockRejectedValue(new Error('/private/disk full'));
    expect(await f.run()).toMatchObject({ status: 'failed', failure: { stage: 'open', cleanupFailed: false } });
    expect(f.release).toHaveBeenCalledOnce(); expect(f.next).not.toHaveBeenCalled();
  });

  it('does not publish when source close cannot release its resources', async () => {
    const f = fixture(); f.release.mockRejectedValue(new Error('native close failed'));
    expect(await f.run()).toMatchObject({ status: 'failed', failure: { stage: 'cleanup', cleanupFailed: true } });
    expect(f.sink.publish).not.toHaveBeenCalled(); expect(f.sink.discard).toHaveBeenCalledOnce();
  });

  it('rejects a terminal integrity failure even after all declared bytes were written', async () => {
    const f = fixture();
    f.next.mockRejectedValueOnce(Object.assign(new Error('checksum'), { detail: { code: 'device-failed', message: 'File checksum mismatch.' } }));
    // The first two responses already queued by the fixture remain before this failure.
    expect(await f.run()).toMatchObject({ status: 'failed', writtenBytes: 3,
      failure: { stage: 'read', error: { message: 'File checksum mismatch.' }, cleanupFailed: false } });
    expect(f.sink.discard).toHaveBeenCalledOnce(); expect(f.sink.publish).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid length', (f: ReturnType<typeof fixture>) => { f.data.totalBytes = -1; }],
    ['partial response', (f: ReturnType<typeof fixture>) => { f.data.returnedRange = { startByte: 1, endByteExclusive: 3 }; }],
    ['mismatched totals', (f: ReturnType<typeof fixture>) => { f.data.responseBytes = 2; }],
    ['wrong source', (f: ReturnType<typeof fixture>) => { f.data.file = { ...file, configurationRevision: 'changed' }; }],
  ])('rejects %s before opening a destination and releases the read', async (_label, change) => {
    const f = fixture(); change(f);
    expect(await f.run()).toMatchObject({ status: 'failed', writtenBytes: 0, failure: { stage: 'validate' } });
    expect(f.createSink).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
  });

  it.each([2, 4])('does not publish a stream whose actual length differs from %i', async size => {
    const f = fixture(); f.data.totalBytes = f.data.responseBytes = size;
    expect(await f.run()).toMatchObject({ status: 'failed', failure: { stage: 'validate' } });
    expect(f.sink.discard).toHaveBeenCalledOnce(); expect(f.sink.publish).not.toHaveBeenCalled();
  });

  it('enforces the host chunk budget before a write', async () => {
    const f = fixture(); f.execution.maxChunkBytes = 1;
    expect(await f.run()).toMatchObject({ status: 'failed', writtenBytes: 0, failure: { stage: 'validate' } });
    expect(f.sink.write).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
    expect(f.sink.discard).toHaveBeenCalledOnce();
  });

  it('supports unknown lengths and empty files without inventing progress totals', async () => {
    const f = fixture(); f.data.totalBytes = f.data.responseBytes = null;
    expect(await f.run()).toMatchObject({ status: 'saved', writtenBytes: 3 });
    expect(f.progress.every(value => value.totalBytes === null)).toBe(true);
    const empty = fixture(); empty.data.totalBytes = empty.data.responseBytes = 0;
    empty.next.mockReset().mockResolvedValue({ done: true, value: undefined });
    expect(await empty.run()).toMatchObject({ status: 'saved', writtenBytes: 0 });
    expect(empty.sink.write).not.toHaveBeenCalled();
  });

  it.each(['write', 'publish'] as const)('cleans up %s failures without exposing host paths', async stage => {
    const f = fixture(); f.sink[stage].mockRejectedValue(new Error('/private/destination access-token'));
    const result = await f.run();
    expect(result).toMatchObject({ status: 'failed', failure: { stage, cleanupFailed: false } });
    expect(JSON.stringify(result)).not.toContain('/private');
    expect(f.sink.discard).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
  });

  it('does not claim clean cancellation when destination cleanup fails', async () => {
    const f = fixture();
    f.sink.write.mockImplementation(async () => { f.signal.abort(); });
    f.sink.discard.mockRejectedValue(new Error('unlink failed'));
    expect(await f.run()).toMatchObject({ status: 'failed', failure: { stage: 'cleanup', cleanupFailed: true } });
    expect(f.sink.publish).not.toHaveBeenCalled();
  });

  it('reports a committed save when cancellation arrives during publication', async () => {
    const f = fixture();
    f.sink.publish.mockImplementation(async () => { f.signal.abort(); return 'committed'; });
    expect(await f.run()).toEqual({ status: 'saved', value: 'committed', writtenBytes: 3 });
    expect(f.sink.discard).not.toHaveBeenCalled();
  });

  it('isolates progress observer errors from file ownership', async () => {
    const f = fixture();
    expect(await executeDownload(file, f.execution, { progress: () => { throw new Error('view unmounted'); } }))
      .toMatchObject({ status: 'saved', writtenBytes: 3 });
  });
});
