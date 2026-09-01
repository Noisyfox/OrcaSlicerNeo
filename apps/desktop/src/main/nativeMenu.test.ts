import { describe, expect, it, vi } from 'vitest';
import type { MenuStateSnapshot } from '../../../../packages/platform-contract/src/menu';
import {
  STARTUP_DISABLED_MENU_MODEL,
  STARTUP_DISABLED_MENU_STATE,
  buildNativeMenuTemplate,
  createNativeMenuController,
  handleHostCommand,
  openFixedSource,
} from './nativeMenu';

function state(overrides: Partial<MenuStateSnapshot['items']> = {}): MenuStateSnapshot {
  return {
    ...STARTUP_DISABLED_MENU_STATE,
    boot: { phase: 'ready', error: null },
    items: { ...STARTUP_DISABLED_MENU_STATE.items, ...overrides },
  };
}

function fakeMenu() {
  const templates: ReturnType<typeof buildNativeMenuTemplate>[] = [];
  const installed: unknown[] = [];
  const buildFromTemplate = vi.fn((template: ReturnType<typeof buildNativeMenuTemplate>) => {
    const items = new Map<string, { enabled: boolean; checked: boolean }>();
    const collect = (entries: ReturnType<typeof buildNativeMenuTemplate>) => {
      for (const item of entries) {
        if (item.id) items.set(item.id, { enabled: item.enabled ?? true, checked: item.checked ?? false });
        if (item.submenu) collect(item.submenu);
      }
    };
    collect(template);
    return { getMenuItemById: (id: string) => items.get(id) ?? null };
  });
  const setApplicationMenu = vi.fn((menu: unknown) => { installed.push(menu); });
  return {
    templates,
    installed,
    api: {
      buildFromTemplate(template: ReturnType<typeof buildNativeMenuTemplate>) {
        templates.push(template);
        return buildFromTemplate(template);
      },
      setApplicationMenu,
    },
    buildFromTemplate,
    setApplicationMenu,
  };
}

describe('Electron native menu boundary', () => {
  it('builds ordered File/Help template with startup-disabled state', () => {
    const template = buildNativeMenuTemplate(STARTUP_DISABLED_MENU_MODEL, STARTUP_DISABLED_MENU_STATE, vi.fn());
    expect(template.map((item) => item.label)).toEqual(['File', 'Help']);
    expect(template[0].submenu?.map((item) => item.label)).toEqual([
      'Add Model', 'Clear Scene', 'Slice', 'Export G-code', undefined, 'Quit',
    ]);
    expect(template[0].submenu?.[0]).toMatchObject({ label: 'Add Model', enabled: false, checked: false });
    expect(template[0].submenu?.[5]).toMatchObject({ label: 'Quit', enabled: true });
    expect(template[1].submenu?.[0]).toMatchObject({ label: 'AGPL-3.0 source', enabled: true });
    expect(STARTUP_DISABLED_MENU_STATE.items.quit.enabled).toBe(true);
  });

  it('installs macOS startup menu and updates enabled/checked state', () => {
    const fake = fakeMenu();
    const controller = createNativeMenuController({ platform: 'darwin', menu: fake.api, onCommand: vi.fn() });

    expect(controller.install()).toBe(true);
    expect(fake.installed).toHaveLength(1);
    expect(fake.buildFromTemplate).toHaveBeenCalledOnce();
    expect(fake.setApplicationMenu).toHaveBeenCalledOnce();
    expect(controller.syncModel(STARTUP_DISABLED_MENU_MODEL)).toBe(true);
    expect(controller.syncState(state({ 'add-model': { enabled: true, checked: true } }))).toBe(true);
    expect(fake.buildFromTemplate).toHaveBeenCalledTimes(2);
    expect(fake.setApplicationMenu).toHaveBeenCalledTimes(2);
    expect(fake.templates.at(-1)?.[0].submenu?.[0]).toMatchObject({ enabled: false, checked: false });
    expect(fake.installed.at(-1)).toBeTruthy();
    const installed = fake.installed.at(-1) as { getMenuItemById(id: string): { enabled: boolean; checked: boolean } | null };
    expect(installed.getMenuItemById('file-add-model')).toEqual({ enabled: true, checked: true });
    const buildCount = fake.buildFromTemplate.mock.calls.length;
    const setCount = fake.setApplicationMenu.mock.calls.length;
    expect(controller.syncState(state({ 'add-model': { enabled: false, checked: true } }))).toBe(true);
    expect(fake.buildFromTemplate).toHaveBeenCalledTimes(buildCount);
    expect(fake.setApplicationMenu).toHaveBeenCalledTimes(setCount);
    expect(installed.getMenuItemById('file-add-model')).toEqual({ enabled: false, checked: true });
    expect(installed.getMenuItemById('file-quit')).toMatchObject({ enabled: true });
  });

  it('keeps native items enabled after a completed slice snapshot', () => {
    const fake = fakeMenu();
    const controller = createNativeMenuController({ platform: 'darwin', menu: fake.api, onCommand: vi.fn() });
    controller.install();
    controller.syncModel(STARTUP_DISABLED_MENU_MODEL);

    // The renderer sends the completed slice with progress 1 (0-1 fraction;
    // see buildMenuStateSnapshot). The snapshot must stay valid and re-enable
    // Slice/Export — regression: raw 0-100 percent here was rejected, the
    // controller fell back to the startup-disabled state, and the native menu
    // never re-enabled after slicing.
    const completed: MenuStateSnapshot = {
      version: 1,
      activeTab: 'prepare',
      boot: { phase: 'ready', error: null },
      slicer: { status: 'done', progress: 1, error: null },
      scene: { hasModel: true },
      result: { hasResult: true, exported: false },
      host: { isElectron: true, menuMode: 'native' },
      items: {
        'add-model': { enabled: true, checked: false },
        'clear-scene': { enabled: true, checked: false },
        slice: { enabled: true, checked: false },
        'export-gcode': { enabled: true, checked: false },
        quit: { enabled: true, checked: false },
        'open-source': { enabled: true, checked: false },
      },
    };
    expect(controller.syncState(completed)).toBe(true);
    const installed = fake.installed.at(-1) as { getMenuItemById(id: string): { enabled: boolean; checked: boolean } | null };
    expect(installed.getMenuItemById('file-slice')).toEqual({ enabled: true, checked: false });
    expect(installed.getMenuItemById('file-export-gcode')).toEqual({ enabled: true, checked: false });
    expect(installed.getMenuItemById('file-add-model')).toEqual({ enabled: true, checked: false });
  });

  it('falls back to disabled state for malformed model or snapshot', () => {
    const fake = fakeMenu();
    const controller = createNativeMenuController({ platform: 'darwin', menu: fake.api, onCommand: vi.fn() });
    controller.install();

    expect(controller.syncModel({ version: 99 })).toBe(false);
    const buildCount = fake.buildFromTemplate.mock.calls.length;
    const setCount = fake.setApplicationMenu.mock.calls.length;
    expect(controller.syncState({ version: 1, items: {} })).toBe(false);
    expect(fake.buildFromTemplate).toHaveBeenCalledTimes(buildCount);
    expect(fake.setApplicationMenu).toHaveBeenCalledTimes(setCount);
    const latest = fake.templates.at(-1)!;
    expect(latest[0].submenu?.[0]).toMatchObject({ enabled: false });
    expect(latest[1].submenu?.[0]).toMatchObject({ enabled: true });
    const installed = fake.installed.at(-1) as { getMenuItemById(id: string): { enabled: boolean; checked: boolean } | null };
    expect(installed.getMenuItemById('file-add-model')).toEqual({ enabled: false, checked: false });
    expect(installed.getMenuItemById('file-quit')).toMatchObject({ enabled: true });
  });

  it('sends only known enabled commands from native item clicks', () => {
    const onCommand = vi.fn();
    const template = buildNativeMenuTemplate(
      STARTUP_DISABLED_MENU_MODEL,
      state({ 'add-model': { enabled: true }, quit: { enabled: false } }),
      onCommand,
    );
    template[0].submenu?.[0].click?.();
    expect(onCommand).toHaveBeenCalledOnce();
    expect(onCommand).toHaveBeenCalledWith('add-model');
  });

  it('clears the application menu on Windows/Linux', () => {
    const fake = fakeMenu();
    const controller = createNativeMenuController({ platform: 'win32', menu: fake.api, onCommand: vi.fn() });
    expect(controller.install()).toBe(false);
    expect(fake.installed).toEqual([null]);
    expect(fake.templates).toHaveLength(0);
  });

  it('allows only quit and opens only the fixed source URL', async () => {
    const quit = vi.fn();
    expect(handleHostCommand('open-source', quit)).toBe(false);
    expect(quit).not.toHaveBeenCalled();
    expect(handleHostCommand('quit', quit)).toBe(true);
    expect(quit).toHaveBeenCalledOnce();

    const openExternal = vi.fn(async () => {});
    await openFixedSource(openExternal);
    expect(openExternal).toHaveBeenCalledWith('https://github.com/Noisyfox/OrcaSlicerNeo');
  });
});
