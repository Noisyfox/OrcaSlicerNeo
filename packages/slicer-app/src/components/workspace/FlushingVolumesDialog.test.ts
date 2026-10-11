import { describe, expect, it } from 'vitest';
import { displayedFlushVolume, rawFlushVolume, flushingModified } from './FlushingVolumesDialog';

describe('flushing display projection', () => {
  it('rounds once, caps displayed volume and never divides by a zero multiplier', () => {
    expect(displayedFlushVolume(123, 0.5, 20000)).toBe(62);
    expect(rawFlushVolume(62, 0.5)).toBe(124);
    expect(rawFlushVolume(10, 0)).toBe(0);
    expect(displayedFlushVolume(10000, 3, 20000)).toBe(20000);
  });
  it('marks a non-default multiplier even when raw values equal native defaults', () => {
    const snapshot = { ok: true as const, revision: 1, dimension: 2, planes: 1, matrix: [0, 123, 456, 0],
      defaults: [0, 123, 456, 0], multipliers: [1], minimums: [0], maximum: 20000 };
    expect(flushingModified(snapshot)).toBe(false);
    expect(flushingModified({ ...snapshot, multipliers: [0.5] })).toBe(true);
    expect(flushingModified({ ...snapshot, matrix: [0, 124, 456, 0] })).toBe(true);
  });
});
