// packages/slicer-app/src/stores/useSettingsStore.test.ts
import { describe, it, expect } from 'vitest';
import { emptyProjectConfigOverlay, useSettingsStore } from './useSettingsStore';
import type { ProfileSnapshot } from '@slicer/client';

const bootSnapshot: ProfileSnapshot = {
  ok: true,
  printers: [{ name: 'P', is_visible: true, is_default: false, vendor_id: '', model: '', variant: '', selected: false }],
  prints: [{ name: 'Q', is_visible: true, is_default: false, vendor_id: '', model: '', variant: '', selected: false }],
  filamentCatalog: [{ name: 'F', is_visible: true, is_default: false, vendor_id: '', model: '', variant: '' }],
  printer: { name: 'P', idx: 1 },
  print: { name: 'Q', idx: 2 },
};

describe('useSettingsStore', () => {
  it('setValue merges into values', () => {
    const s = useSettingsStore.getState();
    s.setValues({ layer_height: '0.2' });
    s.setValue('wall_loops', '3');
    expect(useSettingsStore.getState().values).toEqual({ layer_height: '0.2', wall_loops: '3' });
  });

  it('keeps viewport selection and transforms out of the settings store', () => {
    const s = useSettingsStore.getState();
    expect('selectedVolumeId' in s).toBe(false);
    expect('positions' in s).toBe(false);
    expect('objectMinZ' in s).toBe(false);
  });

  it('advances the model revision for every successful scene change', () => {
    const before = useSettingsStore.getState().modelRevision;
    useSettingsStore.getState().setModelLoaded(true);
    useSettingsStore.getState().setModelLoaded(true);
    useSettingsStore.getState().setModelLoaded(false);
    expect(useSettingsStore.getState().modelRevision).toBe(before + 3);
  });

  it('hydrates all picker boot state from one final compatibility snapshot', () => {
    useSettingsStore.getState().setValues({ layer_height: '0.12' });
    useSettingsStore.getState().hydrateProfileSnapshot(bootSnapshot);
    const state = useSettingsStore.getState();
    expect(state.printers).toBe(bootSnapshot.printers);
    expect(state.prints).toBe(bootSnapshot.prints);
    expect(state.filamentCatalog).toBe(bootSnapshot.filamentCatalog);
    expect([state.selectedPrinter, state.selectedPrint]).toEqual(['P', 'Q']);
    expect(state.printableArea).toEqual([[0, 0], [220, 0], [220, 220], [0, 220]]);
    expect(state.values).toEqual({});
  });

  it('uses native project config as the settings base and overlays project overrides', () => {
    useSettingsStore.getState().hydrateProfileSnapshot({
      ...bootSnapshot,
      project_config: { enable_prime_tower: '1', prime_tower_width: '28' },
    });
    expect(useSettingsStore.getState().values).toMatchObject({
      enable_prime_tower: '1', prime_tower_width: '28',
    });

    useSettingsStore.getState().setOverlay({
      project: { enable_prime_tower: '0' }, objects: {}, parts: {}, plates: {},
    });
    expect(useSettingsStore.getState().values).toMatchObject({
      enable_prime_tower: '0', prime_tower_width: '28',
    });
  });

  it('does not carry an old project overlay into a new profile snapshot', () => {
    useSettingsStore.getState().setOverlay({
      project: { enable_prime_tower: '0' }, objects: {}, parts: {}, plates: {},
    });
    useSettingsStore.getState().hydrateProfileSnapshot({
      ...bootSnapshot,
      project_config: { enable_prime_tower: '1' },
    });

    expect(useSettingsStore.getState().overlay).toEqual(emptyProjectConfigOverlay());
    expect(useSettingsStore.getState().values.enable_prime_tower).toBe('1');
  });

  it('restores the native base when a project replaces an old override with an empty overlay', () => {
    useSettingsStore.getState().hydrateProfileSnapshot({
      ...bootSnapshot,
      project_config: { enable_prime_tower: '1' },
    });
    useSettingsStore.getState().setOverlay({
      project: { enable_prime_tower: '0' }, objects: {}, parts: {}, plates: {},
    });
    useSettingsStore.getState().setOverlay(emptyProjectConfigOverlay());

    expect(useSettingsStore.getState().values.enable_prime_tower).toBe('1');
  });

  it('clears both native base and effective values when settings are cleared', () => {
    useSettingsStore.getState().hydrateProfileSnapshot({
      ...bootSnapshot,
      project_config: { enable_prime_tower: '1' },
    });
    useSettingsStore.getState().setOverlay({
      project: { enable_prime_tower: '0' }, objects: {}, parts: {}, plates: {},
    });
    useSettingsStore.getState().setOverlay(emptyProjectConfigOverlay());
    useSettingsStore.getState().setValues({});

    expect(useSettingsStore.getState().baseValues).toEqual({});
    expect(useSettingsStore.getState().values).toEqual({});
  });
});
