import { describe, expect, it } from 'vitest';
import type { PrimeTowerPlateProjection } from '@slicer/client';
import { clampPrimeTowerPosition, primeTowerWorldBounds } from './primeTowerGeometry';

const projection: PrimeTowerPlateProjection = {
  plateId: 'plate-1', displayIndex: 0, eligible: true, empty: false, forced: false,
  usedSlots: [1, 2], width: 20, depth: 40, height: 10,
  position: { x: 30, y: 40 }, rotation: 90, brimMargin: 2,
  footprint: { minX: 28, maxX: 72, minY: 38, maxY: 82 },
  bands: [
    { slot: 1, startDepth: 0, endDepth: 20, colour: '#333333', opacity: 0.66 },
    { slot: 2, startDepth: 20, endDepth: 40, colour: '#ffd700', opacity: 0.66 },
  ],
  buildArea: { minX: 0, maxX: 100, minY: 0, maxY: 100, maxZ: 100 },
};

describe('prime tower geometry', () => {
  it('clamps the rotated footprint plus brim to native build bounds', () => {
    expect(clampPrimeTowerPosition(projection, { x: 999, y: -999 })).toEqual({ x: 58, y: 2 });
  });

  it('projects the rotated estimate into an ordinary world selection box', () => {
    const bounds = primeTowerWorldBounds(projection, projection.position, [100, 200, 3]);
    expect(bounds.min.toArray()).toEqual([90, 240, 3]);
    expect(bounds.max.toArray()).toEqual([130, 260, 13]);
  });
});
