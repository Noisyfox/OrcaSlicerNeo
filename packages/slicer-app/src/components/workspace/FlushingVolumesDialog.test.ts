import { describe, expect, it } from 'vitest';
import { displayedFlushVolume, rawFlushVolume, recalculateFlushPlane, flushingModified } from './FlushingVolumesDialog';

describe('flushing display projection', () => {
  it('rounds once, caps displayed volume and never divides by a zero multiplier', () => {
    expect(displayedFlushVolume(123, 0.5, 20000)).toBe(62);
    expect(rawFlushVolume(62, 0.5)).toBe(124);
    expect(rawFlushVolume(10, 0)).toBe(0);
    expect(displayedFlushVolume(10000, 3, 20000)).toBe(20000);
  });
  it('recalculates only physical pairs on the selected nozzle', () => {
    const defaults = Array.from({length:18}, (_, i) => i);
    const matrix = Array(18).fill(100);
    const mix = { components:[1,2], ratios:[50,50], gradient:false, perPart:false, reverse:false, points:[], error:'', ramp:[] };
    const editor = {ok:true as const, revision:1, dimension:3, planes:2, slots:[{mix:null},{mix:null},{mix}],
      defaults, matrix, multipliers:[1,1], minimums:[0,0], maximum:20000};
    expect(recalculateFlushPlane(editor, matrix, 1)).toEqual([...matrix.slice(0,9),9,10,100,12,13,100,100,100,100]);
  });
  it('marks a non-default multiplier even when raw values equal native defaults', () => {
    const snapshot = { ok: true as const, revision: 1, dimension: 2, planes: 1, matrix: [0, 123, 456, 0],
      defaults: [0, 123, 456, 0], multipliers: [1], minimums: [0], maximum: 20000 };
    expect(flushingModified(snapshot)).toBe(false);
    expect(flushingModified({ ...snapshot, multipliers: [0.5] })).toBe(true);
    expect(flushingModified({ ...snapshot, matrix: [0, 124, 456, 0] })).toBe(true);
  });
});
