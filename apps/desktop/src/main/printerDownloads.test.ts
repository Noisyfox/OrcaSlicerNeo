import { expect, it, vi } from 'vitest';
import type * as D from '@orca/platform-contract';
import { DesktopPrinterDownloads, type DownloadBinding, type DownloadHost } from './printerDownloads';
import { isDownloadRequest } from '../shared/printerDownloads';
const file: D.RemoteFileRef = { printerId: 'printer' as D.Id<'printer'>, routeId: 'lan' as D.Id<'route'>,
  configurationRevision: 'config', storageId: 'sd' as D.Id<'storage'>, fileId: 'file' as D.Id<'remote-file'> };
const request = { destination: 'default' as const, files: [{ file, name: 'model.3mf', printerName: 'Printer' }] };
const host = (): DownloadHost => ({ destination: vi.fn<DownloadHost['destination']>(async () => ({ kind: 'directory', directory: '/private/saved' })),
  directory: async () => ({ label: 'saved' }), chooseDirectory: async () => ({ status: 'cancelled' }), saveDirectory: async () => null, open: vi.fn(async () => {}) });
const binding = (): DownloadBinding => ({ resolve: vi.fn<DownloadBinding['resolve']>(async () => ({ ok: true, value: { physicalPrinterKey: 'physical' } })),
  execute: vi.fn<DownloadBinding['execute']>(async () => ({ status: 'saved', writtenBytes: 3, value: { path: '/private/saved/model.3mf', fileName: 'model.3mf', cleanupPending: false } })) });
async function waitFor(service: DesktopPrinterDownloads, state: string) {
  await vi.waitFor(async () => { expect((await service.list()).value[0]?.state).toBe(state); });
}
it('routes through a generic binding and only exposes a saved-file task ID to the caller', async () => {
  const h = host(), b = binding(), service = new DesktopPrinterDownloads([b], h);
  const result = await service.start(request); expect(result).toMatchObject({ ok: true, value: { status: 'queued' } });
  await waitFor(service, 'saved'); const list = (await service.list()).value;
  expect(JSON.stringify(list)).not.toContain('/private'); expect(list[0].file).toEqual(file);
  expect(await service.open(list[0].id)).toEqual({ ok: true, value: null }); expect(h.open).toHaveBeenCalledWith('/private/saved/model.3mf');
  expect(await service.open('/arbitrary/path' as D.DownloadTaskId)).toMatchObject({ ok: false }); await service.close();
});
it('shares FIFO between routes and captures a batch before caller selection changes', async () => {
  const h = host(), b = binding(), started: string[] = []; let finish!: () => void;
  b.execute = vi.fn<DownloadBinding['execute']>(async (source, _destination, signal) => {
    started.push(source.routeId); await new Promise<void>(resolve => { finish = resolve; signal.addEventListener('abort', () => resolve(), { once: true }); });
    return { status: 'cancelled', writtenBytes: 0 };
  });
  const service = new DesktopPrinterDownloads([b], h), selected = structuredClone(request);
  const first = service.start(selected); selected.files[0].file.fileId = 'changed' as D.Id<'remote-file'>;
  await first; await vi.waitFor(() => expect(started).toEqual(['lan']));
  await service.start({ ...request, files: [{ ...request.files[0], file: { ...file, routeId: 'cloud' as D.Id<'route'> } }] });
  expect(started).toEqual(['lan']); expect(vi.mocked(b.execute).mock.calls[0][0].fileId).toBe('file');
  finish(); await vi.waitFor(() => expect(started).toEqual(['lan', 'cloud']));
  await service.close(); expect(service.hasUnfinished()).toBe(false);
});
it('pauses a shared failure and retries from zero using the same selected destination', async () => {
  const b = binding(); vi.mocked(b.execute).mockResolvedValueOnce({ status: 'failed', writtenBytes: 7,
    failure: { stage: 'write', cleanupFailed: false, error: { code: 'storage-unavailable', message: 'Disk full.' } } });
  const h = host(), service = new DesktopPrinterDownloads([b], h);
  await service.start(request); await waitFor(service, 'paused'); const id = (await service.list()).value[0].id;
  expect(service.hasUnfinished()).toBe(true); expect(await service.retry(id)).toMatchObject({ ok: true }); await waitFor(service, 'saved');
  expect(h.destination).toHaveBeenCalledOnce(); expect(b.execute).toHaveBeenCalledTimes(2); await service.close();
});
it('does not open a destination for an unsupported/stale source and does not read after a cancelled dialog', async () => {
  const h = host(), b = binding(); vi.mocked(b.resolve).mockResolvedValueOnce({ ok: false, error: { code: 'stale-context', message: 'Changed.' } });
  const service = new DesktopPrinterDownloads([b], h);
  expect(await service.start(request)).toMatchObject({ ok: false, error: { code: 'stale-context' } }); expect(h.destination).not.toHaveBeenCalled();
  vi.mocked(h.destination).mockResolvedValueOnce(null);
  expect(await service.start(request)).toEqual({ ok: true, value: { status: 'cancelled' } }); expect(b.execute).not.toHaveBeenCalled(); await service.close();
});
it('joins cancellation on close and prevents admission from an outstanding dialog', async () => {
  const h = host(), b = binding(); let choose!: () => void;
  h.destination = async () => { await new Promise<void>(resolve => { choose = resolve; }); return { kind: 'directory', directory: '/saved' }; };
  const service = new DesktopPrinterDownloads([b], h); const start = service.start(request);
  await vi.waitFor(() => expect(choose).toBeDefined()); const close = service.close(); choose();
  expect(await start).toMatchObject({ ok: false, error: { code: 'busy' } }); await close; expect(b.execute).not.toHaveBeenCalled();
});
it('rejects paths, URLs, credentials and arbitrary task actions at the public boundary', () => {
  expect(isDownloadRequest({ method: 'start', args: [request] })).toBe(true);
  expect(isDownloadRequest({ method: 'start', args: [{ ...request, path: '/private' }] })).toBe(false);
  expect(isDownloadRequest({ method: 'start', args: [{ ...request, files: [{ ...request.files[0], file: { ...file, url: 'http://other' } }] }] })).toBe(false);
  expect(isDownloadRequest({ method: 'download.run', args: [request] })).toBe(false);
  expect(isDownloadRequest({ method: 'open', args: [{ path: '/private' }] })).toBe(false);
  expect(isDownloadRequest({ method: 'saveDirectory', args: ['selection-id'] })).toBe(true);
  expect(isDownloadRequest({ method: 'saveDirectory', args: [{ path: '/private' }] })).toBe(false);
  expect(isDownloadRequest({ method: 'start', args: [{ ...request, files: Array(501).fill(request.files[0]) }] })).toBe(false);
});
