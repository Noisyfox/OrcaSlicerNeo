import { describe, expect, it } from 'vitest';
import type { PlateSessionSnapshot } from '@slicer/client';
import { canAddPlate, canDeletePlate, MAX_PLATE_COUNT } from './plateControls';

function snapshot(count: number): PlateSessionSnapshot {
  return {
    ok: true,
    version: 1,
    currentPlateId: 'plate-0',
    plates: Array.from({ length: count }, (_, index) => ({
      plateId: `plate-${index}`,
      displayIndex: index,
      origin: [index * 240, 0, 0] as [number, number, number],
      name: `Plate ${index + 1}`,
    })),
  };
}

describe('Prepare plate control availability', () => {
  it('requires an authoritative snapshot and enforces the 36-plate ceiling', () => {
    expect(canAddPlate(null)).toBe(false);
    expect(canAddPlate(snapshot(1))).toBe(true);
    expect(canAddPlate(snapshot(MAX_PLATE_COUNT))).toBe(false);
  });

  it('keeps one plate undeletable', () => {
    expect(canDeletePlate(null)).toBe(false);
    expect(canDeletePlate(snapshot(1))).toBe(false);
    expect(canDeletePlate(snapshot(2))).toBe(true);
  });
});
