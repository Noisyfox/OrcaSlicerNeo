import { describe, expect, it } from 'vitest';
import type { MenuCommandId, MenuStateSnapshotInput, PlatformChrome } from '@orca/platform-contract';
import { buildMenuModel, buildMenuStateSnapshot, deriveMenuItemStates, resolveMenuMode } from './menuModel';

function input(overrides: Partial<MenuStateSnapshotInput> = {}): MenuStateSnapshotInput {
  return {
    version: 1,
    activeTab: 'prepare',
    boot: { phase: 'ready', error: null },
    slicer: { status: 'idle', progress: 0, error: null },
    scene: { hasModel: false },
    result: { hasResult: false, exported: false },
    host: { isElectron: false, menuMode: 'browser' },
    ...overrides,
  };
}

const web: PlatformChrome = { kind: 'web', platform: 'Win32', menuMode: 'browser' };
const windows: PlatformChrome = { kind: 'desktop', platform: 'win32', menuMode: 'custom' };
const linux: PlatformChrome = { kind: 'desktop', platform: 'linux', menuMode: 'custom' };
const mac: PlatformChrome = { kind: 'desktop', platform: 'darwin', menuMode: 'native' };

function menuItems(model: ReturnType<typeof buildMenuModel>, label: string) {
  return model.menus.find((menu) => menu.label === label)!.items;
}

function commandItem(model: ReturnType<typeof buildMenuModel>, command: MenuCommandId) {
  return model.menus.flatMap((menu) => menu.items).find((item) => item.command === command);
}

function stateFor(snapshot: ReturnType<typeof buildMenuStateSnapshot>, command: MenuCommandId) {
  return snapshot.items[command];
}

describe('buildMenuModel', () => {
  it('uses the approved menu mode for Web, Windows/Linux, and macOS', () => {
    expect(resolveMenuMode(web)).toBe('browser');
    expect(resolveMenuMode(windows)).toBe('custom');
    expect(resolveMenuMode(linux)).toBe('custom');
    expect(resolveMenuMode(mac)).toBe('native');
  });

  it('keeps MenuModel static and preserves exact File/Help ordering', () => {
    const state = buildMenuStateSnapshot(input({ host: { isElectron: true, menuMode: 'custom' } }), windows);
    const model = buildMenuModel(state, windows);
    expect(model.menus.map((menu) => menu.label)).toEqual(['File', 'Help']);
    expect(menuItems(model, 'File').map((item) => item.label)).toEqual([
      'Add Model', 'Clear Scene', 'Slice', 'Export G-code', '', 'Exit',
    ]);
    expect(menuItems(model, 'Help').map((item) => item.label)).toEqual(['AGPL-3.0 source']);
    expect(model.menus.flatMap((menu) => menu.items).every((item) => !('enabled' in item))).toBe(true);
    expect(JSON.stringify(model)).not.toMatch(/gizmo|view|cube|shortcut/i);
  });

  it('publishes startup state with disabled File actions and enabled Source', () => {
    const state = buildMenuStateSnapshot(input({ boot: { phase: 'starting', error: null } }), web);
    expect(['add-model', 'clear-scene', 'slice', 'export-gcode'].map((id) => stateFor(state, id as MenuCommandId).enabled)).toEqual([
      false, false, false, false,
    ]);
    expect(stateFor(state, 'open-source')).toEqual({ enabled: true, checked: false });
  });

  it('keeps ready scene prerequisites in the state table', () => {
    const empty = buildMenuStateSnapshot(input(), web);
    expect(stateFor(empty, 'add-model').enabled).toBe(true);
    expect(stateFor(empty, 'clear-scene').enabled).toBe(false);
    expect(stateFor(empty, 'slice').enabled).toBe(false);
    expect(stateFor(empty, 'export-gcode').enabled).toBe(false);

    const withModel = buildMenuStateSnapshot(input({ scene: { hasModel: true } }), web);
    expect(stateFor(withModel, 'clear-scene').enabled).toBe(true);
    expect(stateFor(withModel, 'slice').enabled).toBe(true);
  });

  it.each([
    ['home', false, false, false],
    ['prepare', true, true, true],
    ['preview', false, false, true],
    ['device', false, false, false],
  ] as const)('applies the active-tab policy on %s', (activeTab, addModel, clearScene, slice) => {
    const state = buildMenuStateSnapshot(input({ activeTab, scene: { hasModel: true } }), web);
    expect(stateFor(state, 'add-model').enabled).toBe(addModel);
    expect(stateFor(state, 'clear-scene').enabled).toBe(clearScene);
    expect(stateFor(state, 'slice').enabled).toBe(slice);
  });

  it('keeps export enabled from every page when a valid result exists', () => {
    for (const activeTab of ['home', 'prepare', 'preview', 'device'] as const) {
      const state = buildMenuStateSnapshot(input({
        activeTab,
        scene: { hasModel: true },
        slicer: { status: 'done', progress: 100, error: null },
        result: { hasResult: true, exported: false },
      }), web);
      expect(stateFor(state, 'export-gcode').enabled).toBe(true);
    }
  });

  it('disables all four slicing-period commands and gates export on completed result', () => {
    const slicing = buildMenuStateSnapshot(input({
      scene: { hasModel: true },
      result: { hasResult: true, exported: false },
      slicer: { status: 'slicing', progress: 50, error: null },
    }), web);
    expect(['add-model', 'clear-scene', 'slice', 'export-gcode'].map((id) => stateFor(slicing, id as MenuCommandId).enabled)).toEqual([
      false, false, false, false,
    ]);

    const incomplete = buildMenuStateSnapshot(input({ scene: { hasModel: true }, result: { hasResult: true, exported: false } }), web);
    expect(stateFor(incomplete, 'export-gcode').enabled).toBe(false);

    const completed = buildMenuStateSnapshot(input({
      scene: { hasModel: true },
      slicer: { status: 'done', progress: 100, error: null },
      result: { hasResult: true, exported: false },
    }), web);
    expect(stateFor(completed, 'export-gcode').enabled).toBe(true);
  });

  it('normalizes the store 0-100 percent into the snapshot 0-1 progress fraction', () => {
    // The slicer store and StatusBar use percent (0-100, as reported by the
    // bridge), while the host-facing snapshot carries a 0-1 fraction. The
    // Electron boundary rejects any progress outside [0,1] and falls back to
    // the all-disabled startup state, so a completed slice (progress 100)
    // must project to exactly 1 or the native menu never re-enables.
    const completed = buildMenuStateSnapshot(input({
      scene: { hasModel: true },
      slicer: { status: 'done', progress: 100, error: null },
      result: { hasResult: true, exported: false },
    }), mac);
    expect(completed.slicer.progress).toBe(1);
    expect(stateFor(completed, 'slice').enabled).toBe(false);
    expect(stateFor(completed, 'export-gcode').enabled).toBe(true);

    const midSlice = buildMenuStateSnapshot(input({
      scene: { hasModel: true },
      slicer: { status: 'slicing', progress: 50, error: null },
    }), mac);
    expect(midSlice.slicer.progress).toBe(0.5);
    expect(stateFor(midSlice, 'slice').enabled).toBe(false);
  });

  it('keeps Quit/Exit host-specific, Help available, and checked expressible', () => {
    const webState = buildMenuStateSnapshot(input(), web);
    expect(stateFor(webState, 'quit')).toEqual({ enabled: false, checked: false });
    expect(stateFor(webState, 'open-source')).toEqual({ enabled: true, checked: false });
    expect(commandItem(buildMenuModel(webState, web), 'quit')).toBeUndefined();

    const windowsState = buildMenuStateSnapshot(input({ host: { isElectron: true, menuMode: 'custom' } }), windows);
    expect(stateFor(windowsState, 'quit')).toEqual({ enabled: true, checked: false });
    expect(commandItem(buildMenuModel(windowsState, windows), 'quit')).toMatchObject({ label: 'Exit' });

    const macState = buildMenuStateSnapshot(input({ host: { isElectron: true, menuMode: 'native' } }), mac);
    expect(stateFor(macState, 'quit')).toEqual({ enabled: true, checked: false });
    expect(commandItem(buildMenuModel(macState, mac), 'quit')).toMatchObject({ label: 'Quit' });
  });

  it('returns a complete state table separately from the static model', () => {
    const raw = input({ scene: { hasModel: true } });
    const states = deriveMenuItemStates(raw, web);
    expect(Object.keys(states).sort()).toEqual([
      'add-model', 'clear-scene', 'export-gcode', 'new-project', 'open-project', 'open-source', 'preferences', 'quit', 'save-project', 'save-project-as', 'slice',
    ]);
    expect(states['open-source'].checked).toBe(false);
    expect(buildMenuModel(buildMenuStateSnapshot(raw, web), web).menus).toEqual(buildMenuModel(buildMenuStateSnapshot(raw, web), web).menus);
  });

  it('projects project commands from the session state and keeps Save As enabled for clean content', () => {
    const raw = input({
      project: {
        hasContent: true,
        dirty: false,
        flattenedMultiPlate: false,
        operation: { phase: 'idle', progress: 0, cancellable: false },
      },
    });
    const state = buildMenuStateSnapshot(raw, web);
    const model = buildMenuModel(state, web);
    expect(model.menus[0].items.map((entry) => entry.command).filter(Boolean)).toEqual([
      'add-model', 'clear-scene', 'slice', 'export-gcode',
      'new-project', 'open-project', 'save-project', 'save-project-as', 'preferences',
    ]);
    expect(state.items['new-project'].enabled).toBe(true);
    expect(state.items['save-project'].enabled).toBe(false);
    expect(state.items['save-project-as'].enabled).toBe(true);
  });

  it('locks every menu action while a project operation is waiting or running', () => {
    const state = buildMenuStateSnapshot(input({
      project: {
        hasContent: true,
        dirty: true,
        flattenedMultiPlate: false,
        operation: { phase: 'waiting-for-load-choice', progress: 0, cancellable: false },
      },
      scene: { hasModel: true },
    }), web);
    for (const command of ['new-project', 'open-project', 'save-project', 'save-project-as', 'preferences', 'add-model', 'clear-scene', 'slice'] as const) {
      expect(state.items[command].enabled).toBe(false);
    }
  });
});
