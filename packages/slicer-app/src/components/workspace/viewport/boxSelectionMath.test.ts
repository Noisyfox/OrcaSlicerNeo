import { describe, expect, it } from 'vitest';
import { normalizeRect, rectsOverlap, unionRects } from './boxSelectionMath';

describe('normalizeRect', () => {
  it('orders corners so the rect always has a non-negative size', () => {
    expect(normalizeRect({ x: 10, y: 10 }, { x: 30, y: 40 })).toEqual({
      x: 10, y: 10, width: 20, height: 30,
    });
    expect(normalizeRect({ x: 30, y: 40 }, { x: 10, y: 10 })).toEqual({
      x: 10, y: 10, width: 20, height: 30,
    });
  });

  it('handles drags that only move along one axis', () => {
    expect(normalizeRect({ x: 5, y: 8 }, { x: 5, y: 2 })).toEqual({
      x: 5, y: 2, width: 0, height: 6,
    });
  });
});

describe('rectsOverlap', () => {
  it('detects overlapping and disjoint rects', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectsOverlap(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(rectsOverlap(a, { x: 20, y: 20, width: 10, height: 10 })).toBe(false);
  });

  it('counts edge-touching rects as intersecting', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectsOverlap(a, { x: 10, y: 0, width: 10, height: 10 })).toBe(true);
    expect(rectsOverlap(a, { x: 0, y: 10, width: 10, height: 10 })).toBe(true);
  });

  it('intersects degenerate zero-width marquees like a selection line', () => {
    const line = { x: 5, y: 0, width: 0, height: 100 };
    expect(rectsOverlap(line, { x: 0, y: 20, width: 10, height: 10 })).toBe(true);
    expect(rectsOverlap(line, { x: 20, y: 20, width: 10, height: 10 })).toBe(false);
  });
});

describe('unionRects', () => {
  it('returns the smallest rect containing both inputs', () => {
    expect(unionRects(
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 20, y: 5, width: 5, height: 30 },
    )).toEqual({ x: 0, y: 0, width: 25, height: 35 });
  });
});
