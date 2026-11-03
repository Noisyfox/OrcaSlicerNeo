import { expect, it, vi } from 'vitest';
import type * as D from '@orca/printer-control/domain';
import { TransferQueue } from '@orca/printer-control/transfer-queue';
import { StoredMediaQueue, type StoredMediaBinding } from './storedMediaQueue';
const request = (id: string) => ({ requestId: id, target: { printerId: 'printer', routeId: 'route' }, source: { kind: 'file-preview', previewId: 'video', target: { printerId: 'printer', routeId: 'route', configurationRevision: 'r', storageId: 'sd', fileId: 'movie' } }, client: {} }) as D.OpenMediaRequest;
const descriptor = { ref: { printerId: 'printer', routeId: 'route', id: 'media' } } as D.MediaDescriptor;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function binding() {
  let finish!: () => void;
  const reading = new Promise<void>(resolve => { finish = resolve; });
  const value: StoredMediaBinding = {
    resolve: vi.fn(async () => ({ ok: true as const, value: { physicalPrinterKey: 'physical' } })),
    open: vi.fn(async () => ({ ok: true as const, value: descriptor })),
    waitRead: vi.fn(async () => { await reading; return { ok: true as const, value: null }; }),
    cancelOpen: vi.fn(async () => { finish(); }), close: vi.fn(async () => {}),
  };
  return { value, finish };
}
it('shares FIFO with downloads and frees admission after caching while retaining the viewing resource', async () => {
  const queue = new TransferQueue(2), f = binding(), media = new StoredMediaQueue(queue, f.value);
  let finishDownload!: () => void;
  const download = queue.enqueue({ physicalPrinterKey: 'physical', run: async () => { await new Promise<void>(r => { finishDownload = r; }); return { status: 'finished' }; } });
  const opened = media.open('document', request('one')); await tick(); expect(f.value.open).not.toHaveBeenCalled();
  finishDownload(); await download.finished; expect(await opened).toMatchObject({ ok: true });
  const later = vi.fn(async () => ({ status: 'finished' as const }));
  const ticket = queue.enqueue({ physicalPrinterKey: 'physical', run: later }); await tick(); expect(later).not.toHaveBeenCalled();
  f.finish(); await ticket.finished; expect(later).toHaveBeenCalledOnce(); expect(f.value.close).not.toHaveBeenCalled();
  await media.close('document', descriptor.ref); expect(f.value.close).toHaveBeenCalled(); await queue.stop();
});
it('cancels queued opens without remote reads, including cancellation arriving before admission', async () => {
  const queue = new TransferQueue(1), f = binding(), media = new StoredMediaQueue(queue, f.value);
  const blocker = queue.enqueue({ physicalPrinterKey: 'physical', run: async ({ signal }) => { await new Promise<void>(r => signal.addEventListener('abort', () => r())); return { status: 'finished' }; } });
  const opened = media.open('document', request('one')); await tick(); await media.cancel('document', request('one').requestId);
  expect(await opened).toMatchObject({ ok: false, error: { code: 'cancelled' } }); expect(f.value.open).not.toHaveBeenCalled();
  await media.cancel('document', request('early').requestId); expect(await media.open('document', request('early'))).toMatchObject({ ok: false });
  blocker.cancel(); await queue.stop();
});
it('owner close waits for cancellation and closes only its own resource', async () => {
  const queue = new TransferQueue(1), f = binding(), media = new StoredMediaQueue(queue, f.value);
  await media.open('document', request('one'));
  await media.closeOwner('other'); expect(f.value.close).not.toHaveBeenCalled();
  await media.closeOwner('document'); expect(f.value.cancelOpen).toHaveBeenCalledWith('document', 'one'); expect(f.value.close).toHaveBeenCalledWith('document', descriptor.ref);
  await queue.stop();
});
it('retains a shared-failure head until the viewing resource is explicitly closed', async () => {
  const queue = new TransferQueue(1), f = binding();
  f.value.waitRead = async () => ({ ok: false, error: { code: 'authentication-required', message: 'Authorization expired.' } });
  const media = new StoredMediaQueue(queue, f.value); await media.open('document', request('one')); await tick();
  const run = vi.fn(async () => ({ status: 'finished' as const })); const later = queue.enqueue({ physicalPrinterKey: 'physical', run });
  await tick(); expect(run).not.toHaveBeenCalled(); await media.close('document', descriptor.ref); await later.finished;
  expect(run).toHaveBeenCalledOnce(); await queue.stop();
});
