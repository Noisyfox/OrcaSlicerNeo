import { describe, expect, it } from 'vitest';
import { normalizeArrangementPreferences, normalizeUserPreferences } from './contracts';

describe('host-neutral arrangement preference schema', () => {
  it('keeps independent mode options and shared flags without a 100 mm cap', () => {
    const value = { byLayer: { distance: 125, rotate: true }, byObject: { distance: 7, rotate: false }, multipleMaterials: false, avoidCalibration: false };
    expect(normalizeUserPreferences({ version: 1, arrangement: value }).arrangement).toEqual(value);
  });
  it('uses safe defaults for invalid persistence and never persists transient alignment', () => {
    expect(normalizeArrangementPreferences({ byLayer: { distance: -2, rotate: 'yes' }, byObject: { distance: Infinity }, alignY: true })).toEqual({
      byLayer: { distance: 0, rotate: false }, byObject: { distance: 0, rotate: false }, multipleMaterials: true, avoidCalibration: true,
    });
    expect(normalizeUserPreferences({ version: 1 })).not.toHaveProperty('arrangement');
  });
});
