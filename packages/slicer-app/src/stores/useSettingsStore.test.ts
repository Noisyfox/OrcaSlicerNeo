// apps/desktop/src/renderer/src/stores/useSettingsStore.test.ts
import { describe, it, expect } from 'vitest';
import { useSettingsStore } from './useSettingsStore';

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
});
