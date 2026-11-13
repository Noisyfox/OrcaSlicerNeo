import { unavailablePrinterDownloads } from '@orca/printer-control';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { createMoonrakerService } from '@orca/printer-control';
import type * as D from '@orca/platform-contract';
import { PrinterStorage } from './PrinterStorage';
import { DevicePanel } from './DevicePanel';

const roots: Root[] = [];
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); document.body.innerHTML = ''; });
async function fixture(supportDownloads = false) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const service = createMoonrakerService({ host: { id: 'host' as D.Id<'agent-host'>, name: 'Host', execution: 'desktop' },
    configuration: { load: async () => ({ version: 1, printers: [{ id: 'p', driverId: 'moonraker', displayName: 'Test printer', apiBaseUrl: 'http://printer.local', consoleUrl: '', apiKey: '' }] }), save: async () => {} },
    transport: { request: async () => { throw new Error('No network expected'); } },
  });
  const saved = await service.listSaved(); if (!saved.ok) throw new Error('fixture');
  const printer = saved.value[0], route = printer.routes[0];
  route.capabilities.files.list = { kind: 'unknown', reason: 'Resolve on entry' };
  const storages: D.PrinterStorage[] = ['local', 'removable'].map(id => ({ id: id as D.Id<'storage'>, name: id === 'local' ? 'Onboard' : 'Removable',
    kind: 'other', availability: { kind: 'available' }, capacityBytes: null, freeBytes: null,
    browsing: { kind: 'supported', constraints: { kind: 'collections', collections: [
      { id: 'documents' as D.Id<'file-collection'>, name: 'Documents', kinds: ['other'], actions: ['download'] },
      { id: 'movies' as D.Id<'file-collection'>, name: 'Movies', kinds: ['recording'], actions: ['download', 'preview'] },
    ] } } }));
  const file = (name: string): D.RemoteFile => ({ ref: { printerId: printer.identity.id, routeId: route.id,
    configurationRevision: route.configurationRevision, storageId: storages[0].id, fileId: name as D.Id<'remote-file'> },
    directoryId: null, name, mimeType: null, sizeBytes: 10, createdAtMs: null, modifiedAtMs: 1000, metadata: { kind: 'other' } });
  const listStorages = vi.fn<D.PrinterFiles['listStorages']>(async () => ({ ok: true, value: storages }));
  const list = vi.fn<D.PrinterFiles['list']>(async request => ({ ok: true, value: { directories: [], files: request.cursor ? [file('third')] : [file('first'), file('second')],
    nextCursor: request.cursor ? null : 'next', listingRevision: 'snapshot', pagination: 'snapshot' } }));
  Object.assign(service.files, { listStorages, list });
  service.listSaved = async () => ({ ok: true, value: [printer] });
  const downloads: D.PrinterDownloads = { ...unavailablePrinterDownloads(),
    ...(supportDownloads ? { capability: { kind: 'supported' as const, constraints: {} } } : {}),
    list: vi.fn<D.PrinterDownloads['list']>(async () => ({ ok: true, value: [] })), directory: async () => ({ ok: true, value: { label: 'Downloads' } }),
    start: vi.fn<D.PrinterDownloads['start']>(async () => ({ ok: true, value: { status: 'queued', batchId: 'batch' as D.DownloadBatchId, taskIds: ['task' as D.DownloadTaskId] } })),
    cancel: vi.fn<D.PrinterDownloads['cancel']>(async () => ({ ok: true, value: null })),
  };
  const platform = { printers: { service, downloads }, preferences: { load: async () => ({ ui: {} }) }, webview: { mount: vi.fn() } } as unknown as PlatformCapabilities;
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element); roots.push(root);
  const mount = async (panel = false) => { await act(async () => root.render(<PlatformProvider value={platform}>{panel ? <DevicePanel initialSelection={printer.identity.id} /> : <PrinterStorage printer={printer} route={route} />}</PlatformProvider>)); };
  const click = async (label: string) => { const button = [...element.querySelectorAll('button')].find(button => button.textContent === label); expect(button).toBeDefined(); await act(async () => button!.click()); };
  return { element, root, printer, route, service, mount, click, list, listStorages, storages, file, downloads };
}

it('discovers only on explicit Storage entry and does not poll when selecting or loading another page', async () => {
  const f = await fixture();
  f.route.capabilities.webInterface = { kind: 'unsupported', layer: 'adapter', reason: 'No web page' };
  f.route.capabilities.observations = Object.fromEntries(Object.keys(f.route.capabilities.observations).map(key => [key,
    { kind: 'unsupported', layer: 'adapter', reason: 'Not monitored' }])) as typeof f.route.capabilities.observations;
  await f.mount(true); expect(f.listStorages).not.toHaveBeenCalled(); expect(f.list).not.toHaveBeenCalled();
  await f.click('Storage'); expect(f.listStorages).toHaveBeenCalledTimes(1); expect(f.list).toHaveBeenCalledTimes(1);
  await f.click('Select loaded results');
  expect(f.element.querySelectorAll('input[type=checkbox]:checked')).toHaveLength(2);
  await f.click('Load more files');
  expect(f.element.querySelectorAll('input[type=checkbox]')).toHaveLength(3);
  expect(f.element.querySelectorAll('input[type=checkbox]:checked')).toHaveLength(2);
  expect(f.element.textContent).toContain('2 selected · 3 matching of 3 loaded');
  expect(f.listStorages).toHaveBeenCalledTimes(1); expect(f.list).toHaveBeenCalledTimes(2);
});

it('clears scope selection and ignores an aborted previous-storage response', async () => {
  const f = await fixture(); let finish!: (value: D.Result<D.RemoteFilePage>) => void;
  f.list.mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
  await f.mount();
  const signal = f.list.mock.calls[0][1]!.signal!;
  await act(async () => f.element.querySelector<HTMLElement>('[aria-label="Storage"]')!.click());
  await act(async () => { const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === 'Removable')!; option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); option.click(); });
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ ok: true, value: { directories: [], files: [f.file('obsolete')], nextCursor: null, listingRevision: 'old', pagination: 'snapshot' } }));
  expect(f.element.textContent).not.toContain('obsolete');
  await f.click('Select loaded results'); await f.click('Movies');
  expect(f.element.querySelectorAll('input[type=checkbox]:checked')).toHaveLength(0);
  expect(f.list.mock.calls.at(-1)![0].location).toEqual({ kind: 'collection', collectionId: 'movies' });
});

it('keeps failed capability resolution pending for manual retry and reports an empty collection separately', async () => {
  const f = await fixture();
  f.listStorages.mockResolvedValueOnce({ ok: false, error: { code: 'authentication-required', message: 'Authorize LAN access.' } });
  f.list.mockResolvedValue({ ok: true, value: { directories: [], files: [], nextCursor: null, listingRevision: 'empty', pagination: 'snapshot' } });
  await f.mount(); expect(f.element.querySelector('[role=alert]')?.textContent).toContain('Authorize LAN access.');
  expect(f.listStorages).toHaveBeenCalledTimes(1); expect(f.list).not.toHaveBeenCalled();
  await f.click('Retry'); expect(f.listStorages).toHaveBeenCalledTimes(2); expect(f.list).toHaveBeenCalledTimes(1);
  expect(f.element.textContent).toContain('This collection is empty.');
});
it('offers scoped authorization after an auth error without starting discovery until requested', async () => {
  const f = await fixture();
  f.service.listProviders = async () => ({ ok: true, value: [{ id: f.route.providerId, name: 'Provider', hosts: [{ id: f.route.configuration.hostId,
    name: 'Host', execution: 'desktop', discovery: { kind: 'supported', constraints: { kinds: ['lan'] } } }] }] });
  const discover = vi.fn<D.PrinterService['discover']>(async function* () {}); f.service.discover = discover;
  f.listStorages.mockResolvedValueOnce({ ok: false, error: { code: 'authentication-required', message: 'Authorize this printer.' } });
  await f.mount(); expect(discover).not.toHaveBeenCalled(); expect(f.element.textContent).toContain('Authorize storage access');
  await f.click('Authorize storage access'); expect(discover).toHaveBeenCalledWith(f.route.providerId, { kind: 'lan', hostId: f.route.configuration.hostId }, expect.anything());
  expect(document.body.textContent).toContain('Waiting for this printer on the local network.'); expect(f.listStorages).toHaveBeenCalledOnce();
});

it('refreshes explicitly and reconciles removed identities without selecting newly loaded files', async () => {
  const f = await fixture(); await f.mount(); await f.click('Select loaded results');
  f.list.mockResolvedValue({ ok: true, value: { directories: [], files: [f.file('first'), f.file('new')], nextCursor: null, listingRevision: 'new', pagination: 'snapshot' } });
  await f.click('Refresh');
  expect(f.element.querySelectorAll('input[type=checkbox]:checked')).toHaveLength(1);
  expect(f.element.querySelector('[role="checkbox"][aria-label="Select first"]')?.getAttribute('aria-checked')).toBe('true');
  expect(f.element.querySelector('[role="checkbox"][aria-label="Select new"]')?.getAttribute('aria-checked')).toBe('false');
});

it('queues only explicitly selected files and leaves task ownership with the host on navigation', async () => {
  const f = await fixture(true); await f.mount(); await f.click('Select loaded results'); await f.click('Load more files');
  await f.click('Download selected');
  expect(f.downloads.start).toHaveBeenCalledWith({ destination: 'default', files: ['first', 'second'].map(name => ({ file: f.file(name).ref, name, printerName: f.printer.identity.displayName })) });
  await f.click('Save as…'); expect(vi.mocked(f.downloads.start).mock.calls[1][0].destination).toBe('choose');
  await f.click('Movies'); expect(f.element.querySelector('button')?.disabled).toBeDefined();
  await act(async () => f.root.unmount()); roots.splice(roots.indexOf(f.root), 1);
  expect(f.downloads.cancel).not.toHaveBeenCalled();
});

it('filters storage choices by collection, falls back when switching category, and refreshes changed capabilities', async () => {
  const f = await fixture();
  const browsing = f.storages[1].browsing;
  if (browsing.kind !== 'supported' || browsing.constraints.kind !== 'collections') throw new Error('fixture');
  browsing.constraints.collections = [browsing.constraints.collections[1]];
  await f.mount();
  expect(f.element.querySelector<HTMLElement>('[aria-label="Storage"]')?.closest('[hidden]')).not.toBeNull();
  await f.click('Movies');
  await act(async () => f.element.querySelector<HTMLElement>('[aria-label="Storage"]')!.click());
  await act(async () => { const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === 'Removable')!;
    option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); option.click(); });
  expect(f.list.mock.calls.at(-1)![0].storageId).toBe('removable');
  await f.click('Documents');
  expect(f.list.mock.calls.at(-1)![0]).toMatchObject({ storageId: 'local', location: { collectionId: 'documents' } });
  await f.click('Movies');
  f.storages.splice(1, 1); await f.click('Refresh');
  expect(f.listStorages).toHaveBeenCalledTimes(2);
  expect(f.list.mock.calls.at(-1)![0]).toMatchObject({ storageId: 'local', location: { collectionId: 'movies' } });
  expect(f.element.querySelector<HTMLElement>('[aria-label="Storage"]')?.closest('[hidden]')).not.toBeNull();
});
