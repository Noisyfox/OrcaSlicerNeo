// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import type { MenuCommandId, MenuStateSnapshotInput, PlatformChrome } from '@orca/platform-contract';
import { TitleBar } from '../components/layout/TitleBar';
import { buildMenuModel, buildMenuStateSnapshot } from './menuModel';

const web: PlatformChrome = { kind: 'web', platform: 'Win32', menuMode: 'browser' };
const windows: PlatformChrome = { kind: 'desktop', platform: 'win32', menuMode: 'custom', dragRegion: true };
const linux: PlatformChrome = { kind: 'desktop', platform: 'linux', menuMode: 'custom', dragRegion: true };
const mac: PlatformChrome = {
  kind: 'desktop', platform: 'darwin', menuMode: 'native', dragRegion: true, macSafeInset: true,
};

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function renderTitlebar(element: React.ReactElement) {
  const platform = { runtime: { getRuntimeExecutionState: () => ({ threaded: true, sliceActive: false }) } } as unknown as PlatformCapabilities;
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(<PlatformProvider value={platform}>{element}</PlatformProvider>));
  const html = container.innerHTML;
  act(() => root.unmount());
  return html;
}

function input(overrides: Partial<MenuStateSnapshotInput> = {}): MenuStateSnapshotInput {
  return {
    version: 1,
    activeTab: 'prepare',
    boot: { phase: 'ready', error: null },
    slicer: { status: 'idle', progress: 0, error: null },
    scene: { hasModel: false, arranging: false },
    result: { hasResult: false, exported: false },
    project: { hasContent: true, dirty: false, operation: { phase: 'idle', progress: 0, cancellable: false } },
    host: { isElectron: false, menuMode: 'browser' },
    ...overrides,
  };
}

function items(chrome: PlatformChrome, raw = input()) {
  const state = buildMenuStateSnapshot(raw, chrome);
  return { state, model: buildMenuModel(state, chrome) };
}

function enabled(state: ReturnType<typeof buildMenuStateSnapshot>, command: MenuCommandId) {
  return state.items[command].enabled;
}

describe('shared titlebar menu integration projection', () => {
  it.each([
    ['Web', web, false, 'browser'],
    ['Windows Electron', windows, true, 'custom'],
    ['Linux Electron', linux, true, 'custom'],
    ['macOS Electron', mac, true, 'native'],
  ] as const)('%s keeps the same File/Help business ordering and host surface', (_name, chrome, electron, mode) => {
    const { model } = items(chrome, input({ host: { isElectron: electron, menuMode: mode } }));
    expect(model.menuMode).toBe(mode);
    expect(model.menus.map((menu) => menu.label)).toEqual(['File', 'Help']);
    expect(model.menus[0].items.slice(0, 4).map((item) => item.label)).toEqual([
      'Add Model', 'Clear Scene', 'Slice', 'Export G-code',
    ]);
    expect(model.menus[1].items.map((item) => item.label)).toEqual(['File Manager…', '', 'AGPL-3.0 source']);
    expect(model.menus.flatMap((menu) => menu.items).some((item) => item.command === 'quit')).toBe(electron);
    if (electron) expect(model.menus[0].items.at(-1)?.label).toBe(mode === 'native' ? 'Quit' : 'Exit');
  });

  it('projects startup, model, result, failed, and slicing states consistently', () => {
    const raw = input({ host: { isElectron: true, menuMode: 'custom' }, scene: { hasModel: true, arranging: false } });
    const startup = items(windows, { ...raw, boot: { phase: 'starting', error: null } }).state;
    expect(['add-model', 'clear-scene', 'slice', 'export-gcode'].map((command) => enabled(startup, command as MenuCommandId))).toEqual([
      false, false, false, false,
    ]);
    expect(enabled(startup, 'open-source')).toBe(true);

    const withModel = items(windows, raw).state;
    expect(['add-model', 'clear-scene', 'slice'].map((command) => enabled(withModel, command as MenuCommandId))).toEqual([
      true, true, true,
    ]);
    expect(enabled(withModel, 'export-gcode')).toBe(false);

    const withResult = items(windows, {
      ...raw,
      slicer: { status: 'done', progress: 100, error: null },
      result: { hasResult: true, exported: false },
    }).state;
    expect(enabled(withResult, 'export-gcode')).toBe(true);

    for (const activeTab of ['home', 'device'] as const) {
      const completedElsewhere = items(windows, {
        ...raw,
        activeTab,
        slicer: { status: 'done', progress: 100, error: null },
        result: { hasResult: true, exported: false },
      }).state;
      expect(enabled(completedElsewhere, 'export-gcode')).toBe(true);
      expect(enabled(completedElsewhere, 'add-model')).toBe(false);
      expect(enabled(completedElsewhere, 'clear-scene')).toBe(false);
      expect(enabled(completedElsewhere, 'slice')).toBe(false);
    }

    const failed = items(windows, {
      ...raw,
      boot: { phase: 'failed', error: 'runtime unavailable' },
      slicer: { status: 'error', progress: 0, error: 'slice unavailable' },
    }).state;
    expect(['add-model', 'clear-scene', 'slice', 'export-gcode'].map((command) => enabled(failed, command as MenuCommandId))).toEqual([
      false, false, false, false,
    ]);

    const slicing = items(windows, {
      ...raw,
      slicer: { status: 'slicing', progress: 50, error: null },
      result: { hasResult: true, exported: false },
    }).state;
    expect(['add-model', 'clear-scene', 'slice', 'export-gcode'].map((command) => enabled(slicing, command as MenuCommandId))).toEqual([
      false, false, false, false,
    ]);
  });

  it('renders custom/browser controls inside no-drag titlebar zones and hides native duplicates', () => {
    const customSnapshot = items(windows, input({ host: { isElectron: true, menuMode: 'custom' } }));
    const custom = renderTitlebar(
      <TitleBar chrome={windows} model={customSnapshot.model} state={customSnapshot.state} onCommand={() => {}} />,
    );
    expect(custom).toContain('titlebar-menu');
    expect(custom).toContain('[-webkit-app-region:no-drag]');
    expect(custom).toContain('titlebar-menu-trigger');
    expect(custom).not.toContain('menu-help-trigger');

    const browserSnapshot = items(web);
    const browser = renderTitlebar(
      <TitleBar chrome={web} model={browserSnapshot.model} state={browserSnapshot.state} onCommand={() => {}} />,
    );
    expect(browser).toContain('titlebar-menu');
    expect(browser).not.toContain('file-quit');

    const nativeSnapshot = items(mac, input({ host: { isElectron: true, menuMode: 'native' } }));
    const native = renderTitlebar(
      <TitleBar chrome={mac} model={nativeSnapshot.model} state={nativeSnapshot.state} onCommand={() => {}} />,
    );
    expect(native).not.toContain('titlebar-menu');
    expect(native).toContain('pl-20');
    expect(native).toContain('app-tab-prepare');
    expect(native).toContain('titlebar-save-project');
  });
});
