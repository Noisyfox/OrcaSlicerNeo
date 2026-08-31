import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MenuStateSnapshot, PlatformChrome } from '@orca/platform-contract';
import { buildMenuModel, buildMenuStateSnapshot } from '../../menu/menuModel';
import { TitleBar } from './TitleBar';

function state(chrome: PlatformChrome): MenuStateSnapshot {
  return buildMenuStateSnapshot({
    version: 1,
    activeTab: 'prepare',
    boot: { phase: 'ready', error: null },
    slicer: { status: 'idle', progress: 0, error: null },
    scene: { hasModel: true },
    result: { hasResult: false, exported: false },
    host: { isElectron: chrome.kind === 'desktop', menuMode: chrome.menuMode },
  }, chrome);
}

function markup(chrome: PlatformChrome) {
  const snapshot = state(chrome);
  return renderToStaticMarkup(
    <TitleBar
      chrome={chrome}
      model={buildMenuModel(snapshot, chrome)}
      state={snapshot}
      onCommand={vi.fn()}
    />,
  );
}

describe('TitleBar menu surface', () => {
  it('renders custom Electron and browser menus with explicit no-drag controls', () => {
    const customChrome = { kind: 'desktop' as const, platform: 'win32', menuMode: 'custom' as const, dragRegion: true };
    const browserChrome = { kind: 'web' as const, platform: 'Win32', menuMode: 'browser' as const };
    const custom = markup(customChrome);
    const browser = markup(browserChrome);
    const customModel = buildMenuModel(state(customChrome), customChrome);
    const browserModel = buildMenuModel(state(browserChrome), browserChrome);

    expect(custom).toContain('titlebar-menu');
    expect(custom).toContain('no-drag');
    expect(custom).toContain('File');
    expect(custom).toContain('Help');
    expect(browser).toContain('titlebar-menu');
    expect(customModel.menus[0].items.some((item) => item.command === 'quit')).toBe(true);
    expect(browserModel.menus[0].items.some((item) => item.command === 'quit')).toBe(false);
  });

  it('keeps macOS native titlebar empty while retaining the safe inset', () => {
    const native = markup({
      kind: 'desktop',
      platform: 'darwin',
      menuMode: 'native',
      dragRegion: true,
      macSafeInset: true,
    });

    expect(native).not.toContain('titlebar-menu');
    expect(native).toContain('pl-20');
    expect(native).not.toContain('OrcaSlicerNeo');
    expect(native).not.toContain('AGPL-3.0 source');
  });

  it('does not render a titlebar app name or standalone source link', () => {
    const html = markup({ kind: 'web', platform: 'Win32', menuMode: 'browser' });
    expect(html).not.toContain('OrcaSlicerNeo');
    expect(html).not.toContain('<a');
  });
});
