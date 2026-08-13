import { describe, it, expect } from 'vitest';
import { useSettingsStore } from './useSettingsStore';
import { useSlicerStore } from './useSlicerStore';

// Minimal store contract tests (Task 5). Task 6 and Task 9 add their own
// per-store test files (useSettingsStore.test.ts / useSlicerStore.test.ts);
// this file is named stores.test.ts so it does not collide with either.

describe('useSettingsStore', () => {
  it('starts empty and applies presets + values', () => {
    const s = useSettingsStore.getState();
    expect(s.metadata).toBeNull();
    expect(s.printers).toEqual([]);
    expect(s.prints).toEqual([]);
    expect(s.filaments).toEqual([]);
    expect(s.values).toEqual({});

    s.setPresets(['A1'], ['PLA'], ['Basic']);
    expect(useSettingsStore.getState().printers).toEqual(['A1']);
    expect(useSettingsStore.getState().prints).toEqual(['PLA']);
    expect(useSettingsStore.getState().filaments).toEqual(['Basic']);

    s.setValue('wall_loops', '3');
    s.setValue('wall_loops', '4');
    expect(useSettingsStore.getState().values).toEqual({ wall_loops: '4' });

    s.setValues({ layer_height: '0.2', wall_loops: '3' });
    expect(useSettingsStore.getState().values).toEqual({ layer_height: '0.2', wall_loops: '3' });
  });
});

describe('useSlicerStore', () => {
  it('tracks slice status, progress, layers and error', () => {
    const s = useSlicerStore.getState();
    expect(s.status).toBe('idle');
    expect(s.progress).toBe(0);
    expect(s.layers).toBe(0);
    expect(s.error).toBeNull();

    s.setStatus('slicing');
    s.setProgress(42);
    s.setLayers(80);
    expect(useSlicerStore.getState().status).toBe('slicing');
    expect(useSlicerStore.getState().progress).toBe(42);
    expect(useSlicerStore.getState().layers).toBe(80);

    s.setError('boom');
    expect(useSlicerStore.getState().error).toBe('boom');
    s.setError(null);
    expect(useSlicerStore.getState().error).toBeNull();
  });
});
