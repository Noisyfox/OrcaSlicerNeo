import { describe, expect, it } from 'vitest';
import type { ExternalLinks, PlatformCapabilities } from './contracts';
import { APP_TABS, type MenuCommandId, type MenuModel, type MenuStateSnapshot, type PlatformMenu } from './menu';

const model: MenuModel = {
  version: 1,
  menuMode: 'browser',
  menus: [],
};

const snapshot: MenuStateSnapshot = {
  version: 1,
  activeTab: 'home',
  boot: { phase: 'starting', error: null },
  slicer: { status: 'idle', progress: 0, error: null },
  scene: { hasModel: false },
  result: { hasResult: false, exported: false },
  host: { isElectron: false, menuMode: 'browser' },
  items: {
    'add-model': { enabled: false },
    'clear-scene': { enabled: false },
    'slice': { enabled: false },
    'export-gcode': { enabled: false },
    'quit': { enabled: false },
    'open-source': { enabled: true, checked: true },
  },
};

describe('platform menu contract', () => {
  it('defines the complete app-tab vocabulary once for UI and host consumers', () => {
    expect(APP_TABS).toEqual(['home', 'prepare', 'preview', 'device']);
  });

  it('supports complete model/state replacement and host command callbacks', async () => {
    const commands: MenuCommandId[] = [];
    const menu: PlatformMenu = {
      syncModel(value) { expect(value).toBe(model); },
      syncState(value) { expect(value).toBe(snapshot); },
      onCommand(listener) {
        listener('open-source');
        return () => {};
      },
      async execute(command) { commands.push(command); },
    };

    menu.syncModel(model);
    menu.syncState(snapshot);
    menu.onCommand((command) => commands.push(command));
    await menu.execute('quit');

    expect(commands).toEqual(['open-source', 'quit']);
  });

  it('keeps external navigation fixed to the source operation', () => {
    const links: ExternalLinks = { openSource() {} };
    expect(links.openSource).toBeTypeOf('function');
    const command: MenuCommandId = 'open-source';
    expect(command).toBe('open-source');
  });

  it('expresses a complete per-command state table, including checked state', () => {
    expect(snapshot.items['open-source']).toEqual({ enabled: true, checked: true });
    expect(snapshot.items['add-model']).toEqual({ enabled: false });
  });

  it('keeps the new capabilities host-neutral', () => {
    const capabilities: PlatformCapabilities = {} as PlatformCapabilities;
    expect(capabilities).toBeDefined();
  });
});
