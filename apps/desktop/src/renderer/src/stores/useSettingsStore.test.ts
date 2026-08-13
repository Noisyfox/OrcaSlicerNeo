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
});

describe('useSettingsStore viewport state', () => {
  it('marks a loaded model and tracks selection + offset', () => {
    const s = useSettingsStore.getState();
    s.setModelLoaded(true);
    s.setSelectedObject(0);
    s.setInstanceOffset([10, 20, 0]);
    expect(useSettingsStore.getState().modelLoaded).toBe(true);
    expect(useSettingsStore.getState().selectedObject).toBe(0);
    expect(useSettingsStore.getState().instanceOffset).toEqual([10, 20, 0]);
  });
});
