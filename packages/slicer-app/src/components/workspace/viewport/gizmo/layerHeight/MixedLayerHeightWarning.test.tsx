// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_USER_PREFERENCES, normalizeUserPreferences, type UserPreferences } from '@orca/platform-contract';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { SceneInteractionController } from '../../SceneInteractionController';
import { MixedLayerHeightWarning } from './MixedLayerHeightWarning';

const model = vi.hoisted(() => vi.fn());
const platform = vi.hoisted(() => ({
  runtime: { getModelStructure: model },
  preferences: { load: vi.fn(), save: vi.fn() },
}));
vi.mock('@orca/platform-contract', async original => ({
  ...await original<typeof import('@orca/platform-contract')>(), usePlatform: () => platform,
}));

describe('mixed sublayer warning', () => {
  it('checks the stored native curve when enabling, warns on entry and persists one choice for both', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('PointerEvent', MouseEvent);
    let prefs: UserPreferences = DEFAULT_USER_PREFERENCES;
    platform.preferences.load.mockImplementation(async () => prefs);
    platform.preferences.save.mockImplementation(async next => { prefs = normalizeUserPreferences(next); });
    const listeners = new Set<() => void>();
    const scene = { gizmo: null as string | null, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); } };
    const setEditor = async (open: boolean) => act(async () => { scene.gizmo = open ? 'layer-height' : null; listeners.forEach(fn => fn()); });
    const configure = async (enabled: boolean) => act(async () => { useSettingsStore.setState({ values: { enable_mixed_color_sublayer: enabled ? '1' : '0' } }); });
    const node = document.body.appendChild(document.createElement('div'));
    const root = createRoot(node);
    const dialog = () => document.querySelector('[role="dialog"]');
    const ok = () => [...document.querySelectorAll('button')].find(b => b.textContent === 'OK')!;
    try {
      await configure(false);
      await act(async () => root.render(<MixedLayerHeightWarning scene={scene as unknown as SceneInteractionController} />));
      model.mockResolvedValue({ ok: true, objects: [{}] });
      await configure(true);
      expect(dialog()).toBeNull();
      await setEditor(true);
      expect(dialog()?.textContent).toContain('poor color mixing quality');
      await act(async () => ok().click());
      await setEditor(false);
      await configure(false);
      model.mockResolvedValue({ ok: true, objects: [{ hasVariableLayerHeight: true }] });
      await configure(true);
      expect(dialog()).not.toBeNull();
      await act(async () => dialog()!.querySelector<HTMLElement>('[role="checkbox"]')!.click());
      await act(async () => ok().click());
      expect(prefs.suppressMixedLayerHeightWarning).toBe(true);
      await setEditor(true);
      expect(dialog()).toBeNull();
      await configure(false);
      await configure(true);
      expect(dialog()).toBeNull();
    } finally {
      await act(async () => root.unmount());
      node.remove();
      vi.unstubAllGlobals();
    }
  });
});
