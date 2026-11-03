// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import type * as D from '@orca/printer-control/domain';
import { StorageThumbnail } from './StorageThumbnail';
const roots: Root[] = [];
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); vi.unstubAllGlobals(); document.body.innerHTML = ''; });
it('reads only in view, releases its media lease when hidden and never downloads a missing image', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let visibility!: IntersectionObserverCallback;
  vi.stubGlobal('IntersectionObserver', class { constructor(callback: IntersectionObserverCallback) { visibility = callback; } observe() {} disconnect() {} });
  const file = { name: 'part', ref: { printerId: 'p', routeId: 'r', configurationRevision: 'c', storageId: 's', fileId: 'f' } } as D.RemoteFile;
  const descriptor: D.MediaDescriptor = { ref: { printerId: 'p', routeId: 'r', id: 'image' } as D.MediaRef,
    source: { kind: 'file-preview', target: file.ref, previewId: 'thumb' as D.Id<'preview-option'> }, configurationRevision: 'c', revision: 1, expiresAtMs: null,
    presentation: { kind: 'image', mimeType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' } };
  const list = vi.fn(async () => ({ ok: true, value: { file: file.ref, options: [{ id: 'thumb', kind: 'thumbnail', label: 'Image', contentFormat: null }] } }));
  const open = vi.fn(async () => ({ ok: true, value: descriptor })), close = vi.fn(async () => ({ ok: true, value: null })), download = vi.fn();
  const service = { files: { listPreviews: list, download }, media: { open, close } } as unknown as D.PrinterService;
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element); roots.push(root);
  await act(async () => root.render(<PlatformProvider value={{ printers: { service } } as PlatformCapabilities}><StorageThumbnail file={file} fallback="No image" /></PlatformProvider>));
  expect(list).not.toHaveBeenCalled();
  await act(async () => visibility([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(element.querySelector('img')?.alt).toBe('Thumbnail of part'); expect(open).toHaveBeenCalledOnce();
  await act(async () => visibility([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(close).toHaveBeenCalledWith(descriptor.ref); expect(element.querySelector('img')).toBeNull();
  list.mockResolvedValueOnce({ ok: true, value: { file: file.ref, options: [] } });
  await act(async () => visibility([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(open).toHaveBeenCalledOnce(); expect(download).not.toHaveBeenCalled();
});
