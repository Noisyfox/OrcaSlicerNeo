import { describe, expect, it, vi } from 'vitest';
import type { ElectronBridge } from '../shared/ipc';
import { Ipc } from '../shared/ipc';

const electronMocks = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(async () => undefined),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronMocks.expose },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    send: electronMocks.send,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
}));

await import('./index');

describe('Electron preload bridge', () => {
  it('exposes only narrow menu/source operations and fixed channels', async () => {
    const bridge = electronMocks.expose.mock.calls[0]?.[1] as ElectronBridge;
    const model = { version: 1 as const, menuMode: 'native' as const, menus: [] };
    const snapshot = {
      version: 1 as const,
      activeTab: 'home' as const,
      boot: { phase: 'starting' as const, error: null },
      slicer: { status: 'idle' as const, progress: 0, error: null },
      scene: { hasModel: false },
      result: { hasResult: false, exported: false },
      host: { isElectron: true, menuMode: 'native' as const },
      items: {
        'add-model': { enabled: false }, 'clear-scene': { enabled: false },
        slice: { enabled: false }, 'export-gcode': { enabled: false },
        quit: { enabled: false }, 'open-source': { enabled: true },
      },
    };

    bridge.menu.syncModel(model);
    bridge.menu.syncState(snapshot);
    await bridge.menu.executeHostCommand('quit');
    await bridge.externalLinks.openSource();

    expect(electronMocks.send).toHaveBeenNthCalledWith(1, Ipc.syncMenuModel, model);
    expect(electronMocks.send).toHaveBeenNthCalledWith(2, Ipc.syncMenuState, snapshot);
    expect(electronMocks.invoke).toHaveBeenCalledWith(Ipc.executeHostCommand, 'quit');
    expect(electronMocks.invoke).toHaveBeenCalledWith(Ipc.openSource);
    expect(bridge).not.toHaveProperty('ipcRenderer');
    expect(bridge).not.toHaveProperty('shell');
    expect(bridge).not.toHaveProperty('invoke');
  });

  it('filters native command events and removes the exact listener', () => {
    const bridge = electronMocks.expose.mock.calls[0]?.[1] as ElectronBridge;
    const listener = vi.fn();
    const cleanup = bridge.menu.onCommand(listener);
    const handler = electronMocks.on.mock.calls.at(-1)?.[1] as (event: unknown, value: unknown) => void;

    handler({}, 'quit');
    handler({}, 'arbitrary-channel');
    expect(listener).toHaveBeenCalledWith('quit');
    expect(listener).toHaveBeenCalledOnce();

    cleanup();
    expect(electronMocks.removeListener).toHaveBeenCalledWith(Ipc.nativeMenuCommand, handler);
  });

  it('validates printer configuration payloads and uses dedicated IPC channels', async () => {
    const bridge = electronMocks.expose.mock.calls[0]?.[1] as ElectronBridge;
    const document = {
      version: 1 as const,
      printers: [{
        id: 'p1', displayName: 'Printer', driverId: 'moonraker' as const,
        consoleUrl: 'http://printer.local/console', apiBaseUrl: 'http://printer.local:7125',
        apiKey: 'complete-key',
      }],
    };
    await bridge.printers.configuration.save(document);
    expect(electronMocks.invoke).toHaveBeenCalledWith(Ipc.printerConfigurationSave, {
      ...document,
      printers: [{ ...document.printers[0], apiBaseUrl: 'http://printer.local:7125/' }],
    });
    const callsBeforeInvalid = electronMocks.invoke.mock.calls.length;
    await expect(bridge.printers.configuration.save({ version: 1, printers: [{ ...document.printers[0], apiKey: 42 }] } as never)).rejects.toThrow();
    expect(electronMocks.invoke.mock.calls).toHaveLength(callsBeforeInvalid);
  });

  it('exposes structured transport IPC and filters progress payloads', async () => {
    const bridge = electronMocks.expose.mock.calls[0]?.[1] as ElectronBridge;
    const listener = vi.fn();
    const cleanup = bridge.printers.transport.onProgress(listener);
    const handler = electronMocks.on.mock.calls.at(-1)?.[1] as (event: unknown, id: unknown, progress: unknown) => void;
    handler({}, 'request-1', { loaded: 2, total: 4 });
    handler({}, 'request-1', { loaded: 'secret-key' });
    expect(listener).toHaveBeenCalledWith('request-1', { loaded: 2, total: 4 });
    expect(listener).toHaveBeenCalledOnce();
    cleanup();
    expect(electronMocks.removeListener).toHaveBeenCalledWith(Ipc.printerTransportProgress, handler);
    await bridge.printers.transport.request('request-1', {
      method: 'POST', url: 'http://printer.local/upload', headers: { 'X-Api-Key': 'secret-key' },
      body: { kind: 'json', json: '{}' },
    });
    expect(electronMocks.invoke).toHaveBeenCalledWith(Ipc.printerTransportRequest, 'request-1', expect.objectContaining({
      method: 'POST', body: { kind: 'json', json: '{}' },
    }));
    await bridge.printers.transport.cancel('request-1');
    expect(electronMocks.invoke).toHaveBeenCalledWith(Ipc.printerTransportCancel, 'request-1');
  });

  it('exposes project bytes and opaque location tokens without a path API', async () => {
    const bridge = electronMocks.expose.mock.calls[0]?.[1] as ElectronBridge;
    await bridge.projects.open();
    await bridge.projects.save('opaque-token', 'scene.3mf', new ArrayBuffer(2));
    await bridge.projects.saveAs('scene.3mf', new ArrayBuffer(2));
    expect(electronMocks.invoke).toHaveBeenCalledWith(Ipc.projectOpen);
    expect(electronMocks.invoke).toHaveBeenCalledWith(Ipc.projectSave, 'opaque-token', 'scene.3mf', expect.any(ArrayBuffer));
    expect(electronMocks.invoke).toHaveBeenCalledWith(Ipc.projectSaveAs, 'scene.3mf', expect.any(ArrayBuffer));
    expect(bridge.projects).not.toHaveProperty('readFile');
  });
});
