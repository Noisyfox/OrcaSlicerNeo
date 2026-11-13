import { describe, expect, it, vi } from 'vitest';
import type { DownloadResult, DownloadProgress, ManagedDownloadRequest, RemoteFileRef } from '@orca/platform-contract';
import { ManagedDownloadTasks } from './downloadTasks';
import { TransferQueue } from './transferQueue';
const file = { printerId: 'p', routeId: 'r', configurationRevision: 'c', storageId: 's', fileId: 'f' } as RemoteFileRef;
const saved = (value = '/private/file'): DownloadResult<string> => ({ status: 'saved', value, writtenBytes: 3 });
const failure = (code: 'transport' | 'file-not-found' | 'storage-unavailable'): DownloadResult<string> => ({ status: 'failed', writtenBytes: 1,
  failure: { stage: 'read', cleanupFailed: false, error: { code, message: 'Read failed.' } } });
const request = (execute: ManagedDownloadRequest<string>['execute'], physicalPrinterKey = 'p'): ManagedDownloadRequest<string> => ({ file, name: 'part.3mf', printerName: 'Printer', physicalPrinterKey, execute });
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(warning?: (value: string) => string | null) {
  let id = 0; const queue = new TransferQueue(2), changed = vi.fn();
  const tasks = new ManagedDownloadTasks(queue, () => `id-${++id}`, changed, warning);
  return { tasks, queue, changed };
}

describe('managed host download tasks', () => {
  it('tracks a batch with isolated failures, independent printers and host-private receipts', async () => {
    const f = fixture();
    const batch = f.tasks.enqueue([request(async () => failure('file-not-found')), request(async () => saved()), request(async () => saved('/private/other'), 'other')]);
    await tick(); const state = f.tasks.list();
    expect(state.map(task => task.state)).toEqual(['failed', 'saved', 'saved']);
    expect(state.every(task => task.batchId === batch.batchId && task.attempt === 1)).toBe(true);
    expect(JSON.stringify(state)).not.toContain('/private'); expect(f.tasks.saved(batch.taskIds[1])).toBe('/private/file');
    expect(f.tasks.hasUnfinished()).toBe(false); await f.tasks.close();
  });
  it('pauses only the affected printer and retries the blocked head before later files', async () => {
    const f = fixture(), calls: string[] = [], execute = vi.fn<ManagedDownloadRequest<string>['execute']>()
      .mockImplementationOnce(async () => { calls.push('failed'); return failure('transport'); })
      .mockImplementationOnce(async () => { calls.push('retry'); return saved(); });
    const { taskIds } = f.tasks.enqueue([request(execute), request(async () => { calls.push('tail'); return saved(); }), request(async () => saved(), 'other')]);
    await tick(); expect(f.tasks.list().map(task => task.state)).toEqual(['paused', 'waiting', 'saved']);
    expect(calls).toEqual(['failed']); expect(f.tasks.retry(taskIds[0])).toBe(true);
    await tick(); expect(calls).toEqual(['failed', 'retry', 'tail']); expect(f.tasks.list()[0].attempt).toBe(2);
    expect(f.tasks.hasUnfinished()).toBe(false); await f.tasks.close();
  });
  it('acknowledges a shared failure without retrying it and retains accurate batch results', async () => {
    const f = fixture();
    const { taskIds } = f.tasks.enqueue([request(async () => failure('storage-unavailable')), request(async () => saved())]);
    await tick(); expect(f.tasks.continue(taskIds[0])).toBe(true);
    await tick(); expect(f.tasks.list().map(task => task.state)).toEqual(['failed', 'saved']); await f.tasks.close();
  });
  it('removes a waiting task before opening and joins active cancellation', async () => {
    const f = fixture(); let finish!: (result: DownloadResult<string>) => void; let signal!: AbortSignal;
    const later = vi.fn(async () => saved());
    const { taskIds } = f.tasks.enqueue([request(async value => { signal = value; return new Promise(resolve => { finish = resolve; }); }), request(later)]);
    await tick(); expect(f.tasks.cancel(taskIds[1])).toBe(true); expect(f.tasks.cancel(taskIds[0])).toBe(true);
    expect(signal.aborted).toBe(true); expect(later).not.toHaveBeenCalled(); expect(f.tasks.hasUnfinished()).toBe(true);
    finish({ status: 'cancelled', writtenBytes: 1 }); await tick();
    expect(f.tasks.list().map(task => task.state)).toEqual(['cancelled', 'cancelled']); await f.tasks.close();
  });
  it('disables cancellation at publication and preserves a saved result during shutdown', async () => {
    const f = fixture(); let finish!: (result: DownloadResult<string>) => void;
    const { taskIds } = f.tasks.enqueue([request(async (_signal, progress) => {
      progress({ phase: 'finalizing', writtenBytes: 3, totalBytes: 3, canCancel: false });
      return new Promise(resolve => { finish = resolve; });
    })]);
    await tick(); expect(f.tasks.cancel(taskIds[0])).toBe(false);
    const closing = f.tasks.close(); finish(saved()); await closing;
    expect(f.tasks.list()[0].state).toBe('saved');
  });
  it('ignores late progress from an earlier attempt after retry and returns defensive snapshots', async () => {
    const f = fixture(); let previous!: (value: DownloadProgress) => void;
    const execute = vi.fn<ManagedDownloadRequest<string>['execute']>().mockImplementationOnce(async (_signal, progress) => { previous = progress; return failure('file-not-found'); })
      .mockImplementationOnce(async () => saved());
    const { taskIds } = f.tasks.enqueue([request(execute)]); await tick(); f.tasks.retry(taskIds[0]); await tick();
    previous({ phase: 'transferring', writtenBytes: 999, totalBytes: null, canCancel: true });
    const snapshot = f.tasks.list()[0]; expect(snapshot.writtenBytes).toBe(3); expect(snapshot.attempt).toBe(2);
    snapshot.file.fileId = 'mutated' as RemoteFileRef['fileId']; expect(f.tasks.list()[0].file.fileId).toBe('f'); await f.tasks.close();
  });
  it('surfaces unconfirmed cleanup instead of reporting clean cancellation', async () => {
    const f = fixture(); let reject!: (error: Error) => void;
    const { taskIds } = f.tasks.enqueue([request(async () => new Promise((_resolve, fail) => { reject = fail; }))]);
    await tick(); f.tasks.cancel(taskIds[0]); reject(new Error('/private/error')); await tick();
    expect(f.tasks.list()[0]).toMatchObject({ state: 'failed', error: { code: 'transport', message: 'The download executor stopped without confirming cleanup.' } });
    await f.tasks.close();
  });
  it('keeps successful publication final even when receipt warning projection fails', async () => {
    const f = fixture(() => { throw new Error('bad observer'); });
    f.tasks.enqueue([request(async () => saved()), request(async () => saved())]); await tick();
    expect(f.tasks.list().map(task => task.state)).toEqual(['saved', 'saved']);
    expect(f.tasks.list()[0].warning).toContain('was saved'); await f.tasks.close();
  });
});
