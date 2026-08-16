// apps/desktop/src/renderer/src/stores/useSettingsStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from './useSettingsStore';

describe('useSettingsStore', () => {
  beforeEach(() => {
    useSettingsStore.setState({ positions: {}, initialPositions: {}, objectMinZ: {} });
  });

  it('setValue merges into values', () => {
    const s = useSettingsStore.getState();
    s.setValues({ layer_height: '0.2' });
    s.setValue('wall_loops', '3');
    expect(useSettingsStore.getState().values).toEqual({ layer_height: '0.2', wall_loops: '3' });
  });

  it('defaults tool to move and starts with empty transform maps', () => {
    const s = useSettingsStore.getState();
    expect(s.tool).toBe('move');
    expect(s.positions).toEqual({});
    expect(s.initialPositions).toEqual({});
    expect(s.objectMinZ).toEqual({});
  });

  it('setObjectOffsets seeds all three maps', () => {
    useSettingsStore.getState().setObjectOffsets(
      { 0: [1, 2, 3] },
      { 0: [0, 0, 0] },
      { 0: 0 },
    );
    const s = useSettingsStore.getState();
    expect(s.positions).toEqual({ 0: [1, 2, 3] });
    expect(s.initialPositions).toEqual({ 0: [0, 0, 0] });
    expect(s.objectMinZ).toEqual({ 0: 0 });
  });

  it('setObjectOffset updates one object without touching initialPositions', () => {
    useSettingsStore.getState().setObjectOffsets(
      { 0: [0, 0, 0], 1: [5, 5, 5] },
      { 0: [0, 0, 0], 1: [5, 5, 5] },
      {},
    );
    useSettingsStore.getState().setObjectOffset(0, [10, 20, 30]);
    const s = useSettingsStore.getState();
    expect(s.positions).toEqual({ 0: [10, 20, 30], 1: [5, 5, 5] });
    // initialPositions stays the load-time snapshot — Reset needs it.
    expect(s.initialPositions).toEqual({ 0: [0, 0, 0], 1: [5, 5, 5] });
  });
});
