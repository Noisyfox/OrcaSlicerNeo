// packages/slicer-app/src/stores/useSettingsStore.test.ts
import { beforeEach, describe, it, expect } from 'vitest';
import { emptyNativeScopedConfig, useSettingsStore } from './useSettingsStore';
import type { ProfileSnapshot } from '@slicer/client';

function full(snapshot: ReturnType<typeof emptyNativeScopedConfig>, revision = 1) {
  return { version: 1 as const, revision, kind: 'full' as const, snapshot, removedTargets: [] as const };
}

const bootSnapshot: ProfileSnapshot = {
  ok: true,
  printers: [{ name: 'P', is_visible: true, is_default: false, vendor_id: '', model: '', variant: '', selected: false }],
  prints: [{ name: 'Q', is_visible: true, is_default: false, vendor_id: '', model: '', variant: '', selected: false }],
  filamentCatalog: [{ name: 'F', is_visible: true, is_default: false, vendor_id: '', model: '', variant: '' }],
  printer: { name: 'P', idx: 1 },
  print: { name: 'Q', idx: 2 },
};

describe('useSettingsStore', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetNativeScopedConfig();
    useSettingsStore.getState().setValues({});
  });

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

  it('uses native project config as the settings base and applies scoped values', () => {
    useSettingsStore.getState().hydrateProfileSnapshot({
      ...bootSnapshot,
      project_config: { enable_prime_tower: '1', prime_tower_width: '28' },
    });
    expect(useSettingsStore.getState().values).toMatchObject({
      enable_prime_tower: '1', prime_tower_width: '28',
    });

    useSettingsStore.getState().applyNativeScopedConfigTransport(full({
      project: { enable_prime_tower: '0' }, objects: {}, parts: {}, plates: {},
    }));
    expect(useSettingsStore.getState().values).toMatchObject({
      enable_prime_tower: '0', prime_tower_width: '28',
    });
  });

  it('does not carry old scoped values into a new profile snapshot', () => {
    useSettingsStore.getState().applyNativeScopedConfigTransport(full({
      project: { enable_prime_tower: '0' }, objects: {}, parts: {}, plates: {},
    }));
    useSettingsStore.getState().hydrateProfileSnapshot({
      ...bootSnapshot,
      project_config: { enable_prime_tower: '1' },
    });

    expect(useSettingsStore.getState().nativeScopedConfig).toEqual(emptyNativeScopedConfig());
    expect(useSettingsStore.getState().values.enable_prime_tower).toBe('1');
  });

  it('restores the native base when a project replaces scoped values with an empty snapshot', () => {
    useSettingsStore.getState().hydrateProfileSnapshot({
      ...bootSnapshot,
      project_config: { enable_prime_tower: '1' },
    });
    useSettingsStore.getState().applyNativeScopedConfigTransport(full({
      project: { enable_prime_tower: '0' }, objects: {}, parts: {}, plates: {},
    }));
    useSettingsStore.getState().resetNativeScopedConfig();

    expect(useSettingsStore.getState().values.enable_prime_tower).toBe('1');
  });

  it('clears both native base and effective values when settings are cleared', () => {
    useSettingsStore.getState().hydrateProfileSnapshot({
      ...bootSnapshot,
      project_config: { enable_prime_tower: '1' },
    });
    useSettingsStore.getState().applyNativeScopedConfigTransport(full({
      project: { enable_prime_tower: '0' }, objects: {}, parts: {}, plates: {},
    }));
    useSettingsStore.getState().resetNativeScopedConfig();
    useSettingsStore.getState().setValues({});

    expect(useSettingsStore.getState().baseValues).toEqual({});
    expect(useSettingsStore.getState().values).toEqual({});
  });

  it('replaces an affected target map instead of retaining erased keys', () => {
    useSettingsStore.getState().applyNativeScopedConfigTransport(full({
      project: {}, objects: { '42': { keep: '1', erased: 'old' } }, parts: {}, plates: {},
    }, 1));
    expect(useSettingsStore.getState().applyNativeScopedConfigTransport({
      version: 1, revision: 2, kind: 'affected',
      replacements: [{ scope: 'object', id: '42', values: { keep: '2' } }], removedTargets: [],
    })).toBe('applied');
    expect(useSettingsStore.getState().nativeScopedConfig.objects['42']).toEqual({ keep: '2' });
  });

  it('uses tombstones to remove targets and fences stale or gapped receipts', () => {
    useSettingsStore.getState().applyNativeScopedConfigTransport(full({
      project: {}, objects: {}, parts: {}, plates: { 'plate-1': { layer_height: '0.2' } },
    }, 1));
    expect(useSettingsStore.getState().applyNativeScopedConfigTransport({
      version: 1, revision: 2, kind: 'affected', replacements: [],
      removedTargets: [{ scope: 'plate', id: 'plate-1' }],
    })).toBe('applied');
    expect(useSettingsStore.getState().nativeScopedConfig.plates).toEqual({});
    expect(useSettingsStore.getState().applyNativeScopedConfigTransport({
      version: 1, revision: 2, kind: 'affected', replacements: [], removedTargets: [],
    })).toBe('stale');
    expect(useSettingsStore.getState().applyNativeScopedConfigTransport({
      version: 1, revision: 4, kind: 'affected', replacements: [], removedTargets: [],
    })).toBe('refresh-required');
    expect(useSettingsStore.getState().nativeScopedConfigRefreshRequired).toBe(true);
    expect(useSettingsStore.getState().applyNativeScopedConfigTransport(full({
      project: { layer_height: '0.3' }, objects: {}, parts: {}, plates: {},
    }, 2))).toBe('applied');
    expect(useSettingsStore.getState().nativeScopedConfigRefreshRequired).toBe(false);
    expect(useSettingsStore.getState().applyNativeScopedConfigTransport(full({
      project: { layer_height: '0.3' }, objects: {}, parts: {}, plates: {},
    }, 3))).toBe('applied');
    expect(useSettingsStore.getState().nativeScopedConfig.project.layer_height).toBe('0.3');
  });
  it('inserts sparse targets and preserves unrelated map identities across reset and re-edit', () => {
    const store = useSettingsStore.getState();
    store.resetNativeScopedConfig();
    store.applyNativeScopedConfigTransport(full({ project: {}, objects: { keep: { wall_loops: '2' } },
      parts: { keep: { wall_loops: '3' } }, plates: {} }, 0));
    const before = useSettingsStore.getState().nativeScopedConfig;
    const apply = (revision: number, values: Record<string, string>) => store.applyNativeScopedConfigTransport({
      version: 1, revision, kind: 'affected', replacements: [{ scope: 'object', id: 'new', values }], removedTargets: [],
    });
    expect(apply(1, { wall_loops: '4' })).toBe('applied');
    expect(useSettingsStore.getState().nativeScopedConfig.objects.new).toEqual({ wall_loops: '4' });
    expect(apply(2, {})).toBe('applied');
    expect(useSettingsStore.getState().nativeScopedConfig.objects.new).toBeUndefined();
    expect(apply(3, { wall_loops: '5' })).toBe('applied');
    const after = useSettingsStore.getState().nativeScopedConfig;
    expect(after.objects.keep).toBe(before.objects.keep);
    expect(after.parts).toBe(before.parts);
    expect(after.project).toBe(before.project);
    expect(before.objects.new).toBeUndefined();
    expect(useSettingsStore.getState().nativeScopedConfigRefreshRequired).toBe(false);
  });

});
