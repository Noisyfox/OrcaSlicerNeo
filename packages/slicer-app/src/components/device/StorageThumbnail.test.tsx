// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import type * as D from '@orca/printer-control/domain';
import { StorageThumbnail } from './StorageThumbnail';
import { ThumbnailCacheScope } from './media/ThumbnailCache';
const roots: Root[] = [];
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); vi.unstubAllGlobals(); document.body.innerHTML = ''; });
async function fixture() {
  const observers: IntersectionObserverCallback[] = [];
  vi.stubGlobal('IntersectionObserver', class { constructor(callback: IntersectionObserverCallback) { observers.push(callback); } observe() {} disconnect() {} });
  const file = { name: 'part', ref: { printerId: 'p', routeId: 'r', configurationRevision: 'c', storageId: 's', fileId: 'f' } } as D.RemoteFile;
  const descriptor: D.MediaDescriptor = { ref: { printerId: 'p', routeId: 'r', id: 'image' } as D.MediaRef,
    source: { kind: 'file-preview', target: file.ref, previewId: 'thumb' as D.Id<'preview-option'> }, configurationRevision: 'c', revision: 1, expiresAtMs: null, acceptsUserActivity: false,
    presentation: { kind: 'image', mimeType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' } };
  const list = vi.fn(async () => ({ ok: true, value: { file: file.ref, options: [{ id: 'thumb', kind: 'thumbnail', label: 'Image', contentFormat: null }] } }));
  const open = vi.fn(async (): Promise<D.Result<D.MediaDescriptor>> => ({ ok: true, value: descriptor }));
  const close = vi.fn(async () => ({ ok: true, value: null })), download = vi.fn();
  const service = { files: { listPreviews: list, download }, media: { open, close } } as unknown as D.PrinterService;
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element); roots.push(root);
  const render = async (scope = 'session', shown = true, target = file) => act(async () => root.render(
    <PlatformProvider value={{ printers: { service } } as PlatformCapabilities}><ThumbnailCacheScope scope={scope}>
      {shown && <StorageThumbnail file={target} fallback="No image" />}
    </ThumbnailCacheScope></PlatformProvider>));
  const visible = async (value: boolean) => act(async () => observers.at(-1)!([{ isIntersecting: value } as IntersectionObserverEntry], {} as IntersectionObserver));
  await render(); return { file, descriptor, list, open, close, download, element, render, visible };
}
it('copies once, closes the lease immediately and reuses the image after scrolling or filtering/remounting', async () => {
  const f = await fixture(); expect(f.list).not.toHaveBeenCalled();
  await f.visible(true);
  expect(f.element.querySelector('img')?.alt).toBe('Thumbnail of part'); expect(f.close).toHaveBeenCalledWith(f.descriptor.ref);
  for (let i = 0; i < 3; i++) { await f.visible(false); await f.visible(true); }
  await f.render('session', false); await f.render(); await f.visible(true);
  expect(f.element.querySelector('img')).not.toBeNull();
  expect(f.list).toHaveBeenCalledOnce(); expect(f.open).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce(); expect(f.download).not.toHaveBeenCalled();
});
it('invalidates on refresh/scope changes and isolates exact file/configuration references', async () => {
  const f = await fixture(); await f.visible(true);
  await f.render('refresh'); expect(f.open).toHaveBeenCalledTimes(2);
  await f.render('other-storage'); expect(f.open).toHaveBeenCalledTimes(3);
  await f.render('other-storage', true, { ...f.file, ref: { ...f.file.ref, configurationRevision: 'new' } });
  expect(f.open).toHaveBeenCalledTimes(4);
});
it('retains missing previews for the browsing session without retrying remote resources', async () => {
  const f = await fixture(); f.open.mockResolvedValue({ ok: false, error: { code: 'preview-unavailable', message: 'Missing optional image' } });
  await f.visible(true); await f.visible(false); await f.visible(true);
  expect(f.element.querySelector('img')).toBeNull(); expect(f.open).toHaveBeenCalledOnce(); expect(f.list).toHaveBeenCalledOnce();
  await f.render('refresh'); expect(f.open).toHaveBeenCalledTimes(2);
});
it('does not cache transient authorization failures and closes late successful opens after cancellation', async () => {
  const f = await fixture(); f.open.mockResolvedValueOnce({ ok: false, error: { code: 'authentication-required', message: 'Authorize' } });
  await f.visible(true); await f.visible(false);
  let finish!: (result: D.Result<D.MediaDescriptor>) => void;
  f.open.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await f.visible(true); await f.visible(false);
  await act(async () => finish({ ok: true, value: f.descriptor }));
  expect(f.close).toHaveBeenCalledWith(f.descriptor.ref); expect(f.element.querySelector('img')).toBeNull();
  await f.visible(true); expect(f.open).toHaveBeenCalledTimes(3); expect(f.element.querySelector('img')).not.toBeNull();
});
