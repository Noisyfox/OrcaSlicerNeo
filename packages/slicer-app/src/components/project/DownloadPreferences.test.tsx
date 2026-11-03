// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { unavailablePrinterDownloads } from '@orca/printer-control';
import type { PrinterDownloads } from '@orca/printer-control/domain';
import { DownloadPreferences } from './DownloadPreferences';
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); document.body.innerHTML = ''; });
async function fixture() {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const downloads: PrinterDownloads = { ...unavailablePrinterDownloads(), capability: { kind: 'supported', constraints: {} },
    directory: vi.fn<PrinterDownloads['directory']>(async () => ({ ok: true, value: { label: 'Downloads' } })),
    chooseDirectory: vi.fn<PrinterDownloads['chooseDirectory']>(async () => ({ ok: true, value: { status: 'selected', label: 'Shared files' } })),
  };
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const mount = () => act(async () => root!.render(<PlatformProvider value={{ printers: { downloads } } as unknown as PlatformCapabilities}><DownloadPreferences /></PlatformProvider>));
  const change = () => act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Change…')!.click());
  return { container, downloads, mount, change };
}
it('updates the shared host setting immediately and displays only the host-provided label', async () => {
  const f = await fixture(); await f.mount();
  expect(f.container.querySelector('output')?.textContent).toBe('Downloads');
  await f.change();
  expect(f.downloads.chooseDirectory).toHaveBeenCalledExactlyOnceWith();
  expect(f.container.querySelector('output')?.textContent).toBe('Shared files');
  expect(f.container.textContent).toContain('all printer agents');
});
it('preserves the previous folder on cancellation or a failed save', async () => {
  const f = await fixture(); await f.mount();
  vi.mocked(f.downloads.chooseDirectory).mockResolvedValueOnce({ ok: true, value: { status: 'cancelled' } });
  await f.change(); expect(f.container.querySelector('output')?.textContent).toBe('Downloads');
  vi.mocked(f.downloads.chooseDirectory).mockRejectedValueOnce(new Error('private details'));
  await f.change(); expect(f.container.querySelector('output')?.textContent).toBe('Downloads');
  expect(f.container.querySelector('[role=alert]')?.textContent).toBe('The download folder could not be saved.');
});
it('allows retrying a failed folder read', async () => {
  const f = await fixture(); vi.mocked(f.downloads.directory).mockRejectedValueOnce(new Error('unavailable')); await f.mount();
  expect(f.container.querySelector('[role=alert]')).not.toBeNull();
  await act(async () => [...f.container.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click());
  expect(f.container.querySelector('output')?.textContent).toBe('Downloads');
});
it('explains browser-managed saving without offering a directory picker', async () => {
  const f = await fixture(); f.downloads.capability = { kind: 'unsupported', layer: 'adapter', reason: 'Browser saving' }; await f.mount();
  expect(f.container.textContent).toContain('managed by your browser'); expect(f.container.querySelector('button')).toBeNull();
  expect(f.downloads.directory).not.toHaveBeenCalled();
});
