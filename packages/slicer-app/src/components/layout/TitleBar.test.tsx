// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import type { MenuStateSnapshot, PlatformChrome } from '@orca/platform-contract';
import { buildMenuModel, buildMenuStateSnapshot } from '@/menu/menuModel';
import { TitleBar } from './TitleBar';

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

function state(chrome: PlatformChrome): MenuStateSnapshot {
  return buildMenuStateSnapshot({
    version: 1,
    activeTab: 'prepare',
    boot: { phase: 'ready', error: null },
    slicer: { status: 'idle', progress: 0, error: null },
    scene: { hasModel: true, arranging: false },
    result: { hasResult: false, exported: false },
    project: { hasContent: true, dirty: true, operation: { phase: 'idle', progress: 0, cancellable: false } },
    host: { isElectron: chrome.kind === 'desktop', menuMode: chrome.menuMode },
  }, chrome);
}

function markup(chrome: PlatformChrome) {
  const snapshot = state(chrome);
  return renderTitlebar(
    <TitleBar leftSidebarVisible={true} rightSidebarVisible={true} onToggleLeftSidebar={() => undefined} onToggleRightSidebar={() => undefined}
      chrome={chrome}
      model={buildMenuModel(snapshot, chrome)}
      state={snapshot}
      onCommand={vi.fn()}
    />,
  );
}

describe('TitleBar menu surface', () => {
  it('dispatches sidebar toggles and reflects the current page and visibility', () => {
    const chrome: PlatformChrome = { kind: 'web', menuMode: 'browser' };
    const snapshot = state(chrome);
    const leftToggle = vi.fn();
    const rightToggle = vi.fn();
    const platform = { runtime: { getRuntimeExecutionState: () => ({ threaded: true, sliceActive: false }) } } as unknown as PlatformCapabilities;
    const container = document.createElement('div');
    const root = createRoot(container);
    const render = (activeTab: 'prepare' | 'preview', visible: boolean) => act(() => root.render(
      <PlatformProvider value={platform}><TitleBar chrome={chrome} model={buildMenuModel(snapshot, chrome)} state={snapshot} onCommand={vi.fn()} activeTab={activeTab}
        leftSidebarVisible={visible} rightSidebarVisible={visible} onToggleLeftSidebar={leftToggle} onToggleRightSidebar={rightToggle} /></PlatformProvider>,
    ));
    try {
      render('preview', true);
      const left = container.querySelector('[data-testid="titlebar-toggle-left-sidebar"]') as HTMLButtonElement;
      const right = container.querySelector('[data-testid="titlebar-toggle-right-sidebar"]') as HTMLButtonElement;
      expect(left.getAttribute('aria-pressed')).toBe('true');
      expect(right.getAttribute('aria-pressed')).toBe('true');
      act(() => { left.click(); right.click(); });
      expect(leftToggle).toHaveBeenCalledOnce();
      expect(rightToggle).toHaveBeenCalledOnce();
      render('preview', false);
      expect(left.getAttribute('aria-pressed')).toBe('false');
      expect(right.getAttribute('aria-pressed')).toBe('false');
      render('prepare', true);
      expect(left.disabled).toBe(false);
      expect(right.disabled).toBe(true);
    } finally { act(() => root.unmount()); }
  });
  it('renders custom Electron and browser menus with explicit no-drag controls', () => {
    const customChrome = { kind: 'desktop' as const, platform: 'win32', menuMode: 'custom' as const, dragRegion: true };
    const browserChrome = { kind: 'web' as const, platform: 'Win32', menuMode: 'browser' as const };
    const custom = markup(customChrome);
    const browser = markup(browserChrome);
    const customModel = buildMenuModel(state(customChrome), customChrome);
    const browserModel = buildMenuModel(state(browserChrome), browserChrome);

    expect(custom).toContain('titlebar-menu');
    expect(custom).toContain('no-drag');
    expect(custom).toContain('titlebar-menu-trigger');
    expect(custom).not.toContain('menu-help-trigger');
    expect(browser).toContain('titlebar-menu');
    expect(customModel.menus[0].items.some((item) => item.command === 'quit')).toBe(true);
    expect(browserModel.menus[0].items.some((item) => item.command === 'quit')).toBe(false);
  });

  it('keeps macOS native menus while showing shared navigation and quick actions', () => {
    const native = markup({
      kind: 'desktop',
      platform: 'darwin',
      menuMode: 'native',
      dragRegion: true,
      macSafeInset: true,
    });

    expect(native).not.toContain('titlebar-menu');
    expect(native).toContain('pl-20');
    expect(native).toContain('app-tab-prepare');
    expect(native).toContain('titlebar-save-project');
    expect(native).not.toContain('OrcaSlicerNeo');
    expect(native).not.toContain('AGPL-3.0 source');
  });

  it('does not render a titlebar app name or standalone source link', () => {
    const html = markup({ kind: 'web', platform: 'Win32', menuMode: 'browser' });
    expect(html).not.toContain('OrcaSlicerNeo');
    expect(html).not.toContain('<a');
  });
  it('dispatches Save from the titlebar using the shared command state', () => {
    const chrome: PlatformChrome = { kind: 'web', menuMode: 'browser' };
    const snapshot = state(chrome);
    const onCommand = vi.fn();
    const platform = { runtime: { getRuntimeExecutionState: () => ({ threaded: true, sliceActive: false }) } } as unknown as PlatformCapabilities;
    const container = document.createElement('div');
    const root = createRoot(container);
    const render = () => act(() => root.render(<PlatformProvider value={platform}><TitleBar leftSidebarVisible={true} rightSidebarVisible={true} onToggleLeftSidebar={() => undefined} onToggleRightSidebar={() => undefined} chrome={chrome} model={buildMenuModel(snapshot, chrome)} state={snapshot} onCommand={onCommand} /></PlatformProvider>));
    try {
      render();
      const save = container.querySelector('[data-testid="titlebar-save-project"]') as HTMLButtonElement;
      expect(save.disabled).toBe(false);
      act(() => save.click());
      expect(onCommand).toHaveBeenCalledWith('save-project');
      snapshot.items['save-project'].enabled = false;
      render();
      expect((container.querySelector('[data-testid="titlebar-save-project"]') as HTMLButtonElement).disabled).toBe(true);
    } finally { act(() => root.unmount()); }
  });

});
