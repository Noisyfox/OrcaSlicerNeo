// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import type * as D from '@orca/printer-control/domain';
import { StoredVideoDialog } from './StoredVideoDialog';
vi.mock('./media/StoredVideoPlayer', () => ({ StoredVideoPlayer: () => <p>Player fixture</p> }));
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''; });
async function fixture(mode: 'ready' | 'unsupported' | 'late') {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const file = { name: 'movie.mp4', ref: { printerId: 'p', routeId: 'r', configurationRevision: '1', storageId: 's', fileId: 'f' } } as D.RemoteFile;
  const descriptor = { ref: { printerId: 'p', routeId: 'r', id: 'm' }, configurationRevision: '1', revision: 1, expiresAtMs: null, acceptsUserActivity: false,
    presentation: { kind: 'video', live: false } } as D.MediaDescriptor;
  let resolve!: (value: D.Result<D.MediaDescriptor>) => void;
  const open = vi.fn<D.PrinterMedia['open']>(async () => mode === 'late' ? new Promise(done => { resolve = done; })
    : mode === 'unsupported' ? { ok: false, error: { code: 'no-compatible-media', message: 'This format requires a system player.' } } : { ok: true, value: descriptor });
  const close = vi.fn<D.PrinterMedia['close']>(async () => ({ ok: true, value: null }));
  const start = vi.fn(async () => ({ ok: true, value: { status: 'queued' } }));
  const service = { files: { listPreviews: async () => ({ ok: true, value: { options: [{ kind: 'video', id: 'agent-option' }] } }) },
    media: { open, close, watch: async function* () {}, renew: vi.fn() } };
  const platform = { printers: { service, downloads: { capability: { kind: 'supported' }, start } } } as unknown as PlatformCapabilities;
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const dismiss = vi.fn();
  await act(async () => root!.render(<PlatformProvider value={platform}><StoredVideoDialog file={file} printerName="Printer" onClose={dismiss} /></PlatformProvider>));
  return { file, descriptor, open, close, start, dismiss, resolve: () => resolve({ ok: true, value: descriptor }) };
}
it('uses the agent preview option and releases a visible video on navigation', async () => {
  const f = await fixture('ready'); expect(document.body.textContent).toContain('Player fixture');
  expect(f.open.mock.calls[0][0].source).toMatchObject({ previewId: 'agent-option', target: f.file.ref });
  await act(async () => { root!.unmount(); root = undefined; }); expect(f.close).toHaveBeenCalledWith(f.descriptor.ref);
});
it('unsupported playback offers an explicit managed download without automatically saving or retrying', async () => {
  const f = await fixture('unsupported'); expect(document.body.textContent).toContain('This format requires a system player.'); expect(f.start).not.toHaveBeenCalled();
  await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Download for system player')!.click(); });
  expect(f.start).toHaveBeenCalledWith({ files: [{ file: f.file.ref, name: f.file.name, printerName: 'Printer' }], destination: 'default' });
  expect(f.open).toHaveBeenCalledOnce(); expect(document.body.textContent).toContain('Download queued.');
});
it('aborts a queued open and closes a descriptor that arrives after leaving', async () => {
  const f = await fixture('late'); await act(async () => { root!.unmount(); root = undefined; f.resolve(); });
  expect(f.open.mock.calls[0][1]?.signal?.aborted).toBe(true); expect(f.close).toHaveBeenCalledWith(f.descriptor.ref);
});
it('reports explicit-close cleanup failure before offering to dismiss the viewer', async () => {
  const f = await fixture('ready'); f.close.mockResolvedValue({ ok: false, error: { code: 'storage-unavailable', message: 'Cleanup failed.' } });
  await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Close')!.click(); });
  expect(document.body.textContent).toContain('Temporary video cleanup failed'); expect(f.dismiss).not.toHaveBeenCalled();
  await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Close anyway')!.click(); });
  expect(f.dismiss).toHaveBeenCalledOnce();
});
