// packages/slicer-app/src/stores/useSettingsStore.test.ts
import { describe, it, expect } from 'vitest';
import { useSettingsStore } from './useSettingsStore';
import type { ProfileSnapshot } from '@slicer/client';

const bootSnapshot: ProfileSnapshot = {
  ok: true,
  printers: [{ name: 'P', is_visible: true, is_default: false, vendor_id: '', model: '', variant: '', selected: false }],
  prints: [{ name: 'Q', is_visible: true, is_default: false, vendor_id: '', model: '', variant: '', selected: false }],
  filamentCatalog: [{ name: 'F', is_visible: true, is_default: false, vendor_id: '', model: '', variant: '', selected: false }],
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
});
