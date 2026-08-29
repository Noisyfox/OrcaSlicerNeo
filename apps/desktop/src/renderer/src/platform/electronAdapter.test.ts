import { describe, expect, it, vi } from 'vitest';
import { createElectronAdapter } from './electronAdapter';
import type { PrinterConfigurationDocument } from '@orca/printer-control';

function setup(overrides: Record<string, unknown> = {}) {
    const load = vi.fn(async () => ({ found: true, json: { version: 1, selectedProfiles: { printer: 'P' }, ui: { sidebarWidth: 320 } } }));
    const save = vi.fn(async () => {});
    const menu = {
      syncModel: vi.fn(),
      syncState: vi.fn(),
      onCommand: vi.fn(() => () => {}),
      executeHostCommand: vi.fn(async () => {}),
    };
    const externalLinks = { openSource: vi.fn(async () => {}) };
    const configurationLoad = vi.fn<() => Promise<PrinterConfigurationDocument>>(async () => ({ version: 1, printers: [] }));
    const configurationSave = vi.fn(async () => {});
    const transport = {
      request: vi.fn(async () => ({ status: 200, json: {} })),
      cancel: vi.fn(async () => {}),
      onProgress: vi.fn((_listener: (id: string, progress: { loaded: number; total?: number }) => void) => () => {}),
    };
    const host = { preferences: { load, save }, printers: { configuration: { load: configurationLoad, save: configurationSave }, transport }, menu, externalLinks, platform: 'win32', ...overrides };
    vi.stubGlobal('window', { orca: host });
    return { adapter: createElectronAdapter({} as never), load, save, menu, externalLinks, configurationLoad, configurationSave, transport };
}

describe('Electron adapter', () => {
  it('normalizes load and writes the shared preference shape', async () => {
    const { adapter, save } = setup();
    expect(await adapter.preferences.load()).toEqual({ version: 1, selectedProfiles: { printer: 'P' }, ui: { sidebarWidth: 320, switchToDeviceAfterSend: true } });
    await adapter.preferences.save({ version: 1, selectedProfiles: { filament: 'F' }, ui: {} });
    expect(save).toHaveBeenCalledWith({ version: 1, selectedProfiles: { filament: 'F' }, ui: { switchToDeviceAfterSend: true } });
  });

  it('maps native import success to display name and bytes', async () => {
    const { adapter } = setup({ openFileDialog: vi.fn(async () => ({ canceled: false, path: 'C:\\models\\cube.stl' })), readFile: vi.fn(async () => Uint8Array.from([1, 2]).buffer) });
    await expect(adapter.models.pick()).resolves.toEqual({ displayName: 'cube.stl', bytes: Uint8Array.from([1, 2]) });
  });

  it('returns cancellation without reading a file', async () => {
    const readFile = vi.fn();
    const { adapter } = setup({ openFileDialog: vi.fn(async () => ({ canceled: true, path: null })), readFile });
    await expect(adapter.models.pick()).resolves.toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('hands export bytes to native save dialog and write operation', async () => {
    const saveFileDialog = vi.fn(async () => ({ canceled: false, path: 'C:\\out\\slice.gcode' }));
    const writeFile = vi.fn(async () => {});
    const { adapter } = setup({ saveFileDialog, writeFile });
    await adapter.exports.save('output.gcode', Uint8Array.from([3, 4]));
    expect(saveFileDialog).toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledWith('C:\\out\\slice.gcode', expect.any(ArrayBuffer));
  });

  it('does not write when export is cancelled', async () => {
    const writeFile = vi.fn();
    const { adapter } = setup({ saveFileDialog: vi.fn(async () => ({ canceled: true, path: null })), writeFile });
    await adapter.exports.save('output.gcode', Uint8Array.from([3]));
    expect(writeFile).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'win32'])('supplies correct brand-bar props for %s', async (platform) => {
    const { adapter } = setup({ platform });
    expect(adapter.chrome).toMatchObject({
      kind: 'desktop',
      platform,
      menuMode: platform === 'darwin' ? 'native' : 'custom',
      dragRegion: true,
      macSafeInset: platform === 'darwin',
    });
  });

  it('provides type-compatible menu and external-link placeholders', () => {
    const { adapter, menu, externalLinks } = setup();
    const model = { version: 1 as const, menuMode: 'custom' as const, menus: [] };
    const state = { version: 1 as const, boot: { phase: 'starting' as const, error: null }, slicer: { status: 'idle' as const, progress: 0, error: null }, scene: { hasModel: false }, result: { hasResult: false, exported: false }, host: { isElectron: true, menuMode: 'custom' as const }, items: { 'add-model': { enabled: false }, 'clear-scene': { enabled: false }, slice: { enabled: false }, 'export-gcode': { enabled: false }, quit: { enabled: false }, 'open-source': { enabled: true } } };
    adapter.menu.syncModel(model);
    adapter.menu.syncState(state);
    adapter.externalLinks.openSource();
    expect(menu.syncModel).toHaveBeenCalledWith(model);
    expect(menu.syncState).toHaveBeenCalledWith(state);
    expect(externalLinks.openSource).toHaveBeenCalledOnce();
  });

  it('maps quit execute and native command subscription to preload IPC', async () => {
    const { adapter, menu } = setup();
    const listener = vi.fn();
    adapter.menu.onCommand(listener);
    await adapter.menu.execute('quit');
    expect(menu.onCommand).toHaveBeenCalledWith(listener);
    expect(menu.executeHostCommand).toHaveBeenCalledWith('quit');
  });

  it('falls back to in-memory preferences when persistence fails', async () => {
    const load = vi.fn(async () => { throw new Error('unavailable'); });
    const save = vi.fn(async () => { throw new Error('unavailable'); });
    const { adapter } = setup({ preferences: { load, save } });
    const value = { version: 1 as const, selectedProfiles: { printer: 'P' }, ui: { sidebarWidth: 300 } };
    await adapter.preferences.save(value);
    await expect(adapter.preferences.load()).resolves.toEqual({ ...value, ui: { sidebarWidth: 300, switchToDeviceAfterSend: true } });
  });

  it('round-trips complete printer configuration through the typed host API', async () => {
    const { adapter, configurationLoad, configurationSave } = setup();
    const document = { version: 1 as const, printers: [{
      id: 'p1', displayName: 'Printer', driverId: 'moonraker' as const,
      consoleUrl: 'http://printer.local/console', apiBaseUrl: 'http://printer.local:7125/', apiKey: 'complete-key',
    }] };
    configurationLoad.mockResolvedValue(document);
    await expect(adapter.printers.configuration.load()).resolves.toEqual(document);
    await adapter.printers.configuration.save(document);
    expect(configurationSave).toHaveBeenCalledWith(document);
  });

  it('returns an empty printer document when host load is invalid', async () => {
    const { adapter, configurationLoad } = setup();
    configurationLoad.mockResolvedValue({ version: 2, printers: [] } as never);
    await expect(adapter.printers.configuration.load()).resolves.toEqual({ version: 1, printers: [] });
  });

  it('adapts transport requests, progress callbacks, and AbortSignal to typed host IPC', async () => {
    const { adapter, transport } = setup();
    let notify: ((id: string, progress: { loaded: number; total?: number }) => void) | undefined;
    transport.onProgress.mockImplementation((listener) => { notify = listener; return () => {}; });
    const progress = vi.fn();
    const response = await adapter.printers.transport.request({
      method: 'GET', url: 'http://printer.local/status', headers: { 'X-Api-Key': 'key' }, onUploadProgress: progress,
    });
    expect(transport.request).toHaveBeenCalledWith('printer-request-1', expect.objectContaining({ method: 'GET', headers: { 'X-Api-Key': 'key' } }));
    notify?.('printer-request-1', { loaded: 1, total: 2 });
    expect(progress).toHaveBeenCalledWith({ loaded: 1, total: 2 });
    expect(response.status).toBe(200);

    const controller = new AbortController();
    const pending = adapter.printers.transport.request({ method: 'GET', url: 'http://printer.local/status', signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport.cancel).toHaveBeenCalledWith('printer-request-2');
  });
});
