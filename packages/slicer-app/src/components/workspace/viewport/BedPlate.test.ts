import { describe, expect, it } from 'vitest';
import { BED_SIZE, DEFAULT_PRINTABLE_AREA, getPrintableAreaBounds, normalizePrintableArea } from './BedPlate';

describe('profile build plate geometry', () => {
  it('uses the fallback square when printable_area is missing or malformed', () => {
    expect(normalizePrintableArea(undefined)).toBe(DEFAULT_PRINTABLE_AREA);
    expect(normalizePrintableArea([[0, 0], [10, 0]] as Array<[number, number]>)).toBe(DEFAULT_PRINTABLE_AREA);
    expect(normalizePrintableArea([[0, 0], [10, 0], [Number.NaN, 10]] as Array<[number, number]>)).toBe(DEFAULT_PRINTABLE_AREA);
    expect(normalizePrintableArea([[0, 0], null, [10, 10]])).toBe(DEFAULT_PRINTABLE_AREA);
  });

  it('keeps profile coordinates and computes their display bounds', () => {
    const area: Array<[number, number]> = [[-5, 10], [245, 10], [245, 210], [-5, 210]];
    expect(normalizePrintableArea(area)).toBe(area);
    expect(getPrintableAreaBounds(area)).toEqual({
      minX: -5,
      minY: 10,
      maxX: 245,
      maxY: 210,
      width: 250,
      depth: 200,
      centerX: 120,
      centerY: 110,
    });
  });

  it('retains the original fallback dimensions', () => {
    expect(getPrintableAreaBounds(DEFAULT_PRINTABLE_AREA)).toMatchObject({ width: BED_SIZE, depth: BED_SIZE });
  });
});
