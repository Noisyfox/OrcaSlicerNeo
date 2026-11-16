import { describe, expect, it } from 'vitest';
import type { MeasureSelection, MeasureStatus } from '@slicer/client';
import { measureDimensions } from './dimensionGeometry';

const target = { objectId: 1, instanceId: 2, volumeId: 3 };
const point = { type: 'point' as const, point: [0, 0, 0] as const };
const first: MeasureSelection = { target, kind: 'feature', source: point, value: point };
const status: MeasureStatus = { ok: true, version: 1, sessionId: 'ms-1', targetRevision: 1, selectionRevision: 1,
  first, second: first, sameTarget: true, result: {
    infinite: { from: [0, 0, 0], to: [2, 3, 4], value: 5.385164807 }, strict: null, xyz: [2, 3, 4],
    showStrict: false, showXyz: true, angle: { radians: Math.PI / 2, center: [0, 0, 0],
      edge1: [[0, 0, 0], [1, 0, 0]], edge2: [[0, 0, 0], [0, 1, 0]], radius: 2, coplanar: true },
  } };

describe('native Measure dimension projection', () => {
  it('retains the unrounded native value, endpoints, axis segments and angle arc', () => {
    const dimension = measureDimensions(status);
    expect(dimension.distance).toEqual({ from: [0, 0, 0], to: [2, 3, 4], value: 5.385164807 });
    expect(dimension.axes).toEqual([
      { from: [0, 0, 0], to: [2, 0, 0], color: '#ff4f4f' },
      { from: [2, 0, 0], to: [2, 3, 0], color: '#5edc71' },
      { from: [2, 3, 0], to: [2, 3, 4], color: '#4b8bff' },
    ]);
    const arc = dimension.angle!;
    expect(arc.points[0].toArray()).toEqual([2, 0, 0]);
    expect(arc.points.at(-1)?.x).toBeCloseTo(0); expect(arc.points.at(-1)?.y).toBeCloseTo(2);
    expect(arc.label.x).toBeCloseTo(Math.SQRT2); expect(arc.label.y).toBeCloseTo(Math.SQRT2);
  });

  it('shows the sole-circle measurement but not another single feature or a tiny distance', () => {
    expect(measureDimensions({ ...status, second: null }).distance).toBeNull();
    const circle = { type: 'circle' as const, center: [0, 0, 0] as const, normal: [0, 0, 1] as const, radius: 2, diameter: 4 };
    expect(measureDimensions({ ...status, first: { target, kind: 'feature', source: circle, value: circle }, second: null }).distance?.value).toBe(5.385164807);
    expect(measureDimensions({ ...status, result: { ...status.result!, infinite: { from: [0, 0, 0], to: [0.0001, 0, 0], value: .0001 } } }).distance).toBeNull();
  });
});
