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
    const projects = {
      open: vi.fn(async () => ({ canceled: true, locationToken: null, displayName: null, bytes: null })),
      openMany: vi.fn(async () => ({ canceled: true, locationToken: null, displayName: null, bytes: null })),
      openDropped: vi.fn(async () => ({ canceled: true, locationToken: null, displayName: null, bytes: null })),
      save: vi.fn(async () => ({ canceled: false, locationToken: 'project-token' })),
      saveAs: vi.fn(async () => ({ canceled: false, locationToken: 'project-token' })),
    };
    const host = { preferences: { load, save }, projects, printers: { configuration: { load: configurationLoad, save: configurationSave }, transport }, menu, externalLinks, platform: 'win32', ...overrides };
    vi.stubGlobal('window', { orca: host });
    return { adapter: createElectronAdapter({} as never), load, save, menu, externalLinks, configurationLoad, configurationSave, transport };
}

describe('Electron adapter', () => {
  it('normalizes load and writes the shared preference shape', async () => {
    const { adapter, save } = setup();
    expect(await adapter.preferences.load()).toEqual({ version: 1, projectLoadBehaviour: 'ask_when_relevant', selectedProfiles: { printer: 'P' }, ui: { sidebarWidth: 320, switchToDeviceAfterSend: true } });
    await adapter.preferences.save({ version: 1, selectedProfiles: { filament: 'F' }, ui: {} });
    expect(save).toHaveBeenCalledWith({ version: 1, projectLoadBehaviour: 'ask_when_relevant', selectedProfiles: { filament: 'F' }, ui: { switchToDeviceAfterSend: true } });
  });

  it('maps native import success to display name and bytes', async () => {
    const openFileDialog = vi.fn(async () => ({ canceled: false, path: 'C:\\models\\cube.drc' }));
    const { adapter } = setup({ openFileDialog, readFile: vi.fn(async () => Uint8Array.from([1, 2]).buffer) });
    await expect(adapter.models.pick()).resolves.toEqual({ displayName: 'cube.drc', bytes: Uint8Array.from([1, 2]) });
    expect(openFileDialog).toHaveBeenCalledWith([
      { name: 'Models', extensions: ['stl', '3mf', 'drc'] },
      { name: 'All files', extensions: ['*'] },
    ]);
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

  it('opens projects through the dedicated native 3MF capability and keeps only an opaque location', async () => {
    const open = vi.fn(async () => ({ canceled: false, locationToken: 'private-token', displayName: 'cube.3mf', bytes: Uint8Array.from([1, 2]).buffer }));
    const { adapter } = setup({ projects: { open, save: vi.fn(), saveAs: vi.fn() } });
    const result = await adapter.projects.open();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.input).toMatchObject({ displayName: 'cube.3mf', bytes: Uint8Array.from([1, 2]) });
    expect(result.input).not.toHaveProperty('path');
    expect(result.input.location).toBeDefined();
  });

  it('distinguishes project cancellation and failures and saves by opaque token', async () => {
    const save = vi.fn(async () => ({ canceled: false, locationToken: 'saved-token' }));
    const { adapter } = setup({
      projects: {
        open: vi.fn(async () => ({ canceled: true, locationToken: null, displayName: null, bytes: null })),
        save,
        saveAs: vi.fn(async () => ({ canceled: false, locationToken: 'saved-token' })),
      },
    });
    expect(await adapter.projects.open()).toEqual({ status: 'cancelled' });
    const first = await adapter.projects.open();
    expect(first.status).toBe('cancelled');
    const input = { displayName: 'cube', bytes: Uint8Array.from([3]) };
    const saved = await adapter.projects.save(input);
    expect(saved.status).toBe('ok');
    expect(save).not.toHaveBeenCalled(); // Untitled save uses Save As.
  });

  it('keeps the native location token private while saving an opened project', async () => {
    const open = vi.fn(async () => ({ canceled: false, locationToken: 'private-token', displayName: 'scene.3mf', bytes: Uint8Array.from([4, 5]).buffer }));
    const save = vi.fn(async () => ({ canceled: false, locationToken: 'private-token' }));
    const { adapter } = setup({ projects: { open, save, saveAs: vi.fn() } });
    const opened = await adapter.projects.open();
    expect(opened.status).toBe('ok');
    if (opened.status !== 'ok') return;
    const result = await adapter.projects.save(opened.input);
    expect(result.status).toBe('ok');
    expect(save).toHaveBeenCalledWith('private-token', 'scene.3mf', expect.any(ArrayBuffer));
    expect(opened.input.location).not.toHaveProperty('token');
    expect(opened.input.location).not.toHaveProperty('path');
  });

  it('reports native project read/write failures instead of treating them as cancellation', async () => {
    const { adapter } = setup({ projects: {
      open: vi.fn(async () => { throw new Error('read failed'); }),
      save: vi.fn(async () => { throw new Error('write failed'); }),
      saveAs: vi.fn(async () => { throw new Error('write failed'); }),
    } });
    await expect(adapter.projects.open()).resolves.toMatchObject({ status: 'failed' });
    await expect(adapter.projects.save({ displayName: 'scene', bytes: new Uint8Array() })).resolves.toMatchObject({ status: 'failed' });
  });

  it('preserves native save cancellation as cancellation', async () => {
    const { adapter } = setup({ projects: {
      open: vi.fn(async () => ({ canceled: true, locationToken: null, displayName: null, bytes: null })),
      save: vi.fn(async () => ({ canceled: true, locationToken: null })),
      saveAs: vi.fn(async () => ({ canceled: true, locationToken: null })),
    } });
    await expect(adapter.projects.save({ displayName: 'scene', bytes: new Uint8Array([1]) })).resolves.toEqual({ status: 'cancelled' });
  });

  it('adopts dropped Electron files through native opaque locations', async () => {
    const openDropped = vi.fn(async () => ({ canceled: false, locationToken: 'drop-token', displayName: 'drop.3mf', bytes: Uint8Array.from([9]).buffer, files: [{ locationToken: 'drop-token', displayName: 'drop.3mf', bytes: Uint8Array.from([9]).buffer }] }));
    const { adapter } = setup({ projects: { open: vi.fn(), openMany: vi.fn(), openDropped, save: vi.fn(), saveAs: vi.fn() } });
    const file = Object.assign({ name: 'drop.3mf', arrayBuffer: async () => Uint8Array.from([9]).buffer }, { path: 'C:\\drop.3mf' });
    const result = await adapter.projects.openDropped?.([file]);
    expect(openDropped).toHaveBeenCalledWith(['C:\\drop.3mf']);
    expect(result).toMatchObject({ status: 'ok', inputs: [{ displayName: 'drop.3mf' }] });
    expect(result?.status === 'ok' && result.inputs[0]?.location).toBeDefined();
  });

  it('resolves packaged profile assets from the renderer root', async () => {
    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { baseURI: 'file:///opt/orca/out/renderer/index.html' },
    });
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3])),
    );

    try {
      const { adapter } = setup();
      await expect(adapter.profiles.fetch('manifest.json')).resolves.toEqual(new Uint8Array([1, 2, 3]));
      expect(String(request.mock.calls[0]?.[0])).toBe('file:///opt/orca/out/renderer/profiles/manifest.json');
    } finally {
      if (previousDocument === undefined) delete (globalThis as { document?: Document }).document;
      else Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
    }
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
    const state = { version: 1 as const, activeTab: 'home' as const, boot: { phase: 'starting' as const, error: null }, slicer: { status: 'idle' as const, progress: 0, error: null }, scene: { hasModel: false }, result: { hasResult: false, exported: false }, host: { isElectron: true, menuMode: 'custom' as const }, project: { hasContent: false, dirty: false, flattenedMultiPlate: false, operation: { phase: 'idle' as const, progress: 0, cancellable: false } }, items: { 'new-project': { enabled: false }, 'open-project': { enabled: false }, 'save-project': { enabled: false }, 'save-project-as': { enabled: false }, preferences: { enabled: false }, 'add-model': { enabled: false }, 'clear-scene': { enabled: false }, slice: { enabled: false }, 'export-gcode': { enabled: false }, quit: { enabled: false }, 'open-source': { enabled: true } } };
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
    await expect(adapter.preferences.load()).resolves.toEqual({ ...value, projectLoadBehaviour: 'ask_when_relevant', ui: { sidebarWidth: 300, switchToDeviceAfterSend: true } });
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
