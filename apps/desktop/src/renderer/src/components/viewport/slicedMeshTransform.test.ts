import { describe, expect, it } from 'vitest';
import { slicedMeshPosition } from './slicedMeshTransform';

describe('sliced mesh display position', () => {
  it('applies the instance XY placement without double-translating layer Z', () => {
    expect(slicedMeshPosition([35, -12, 8])).toEqual([35, -12, 0]);
  });

  it('uses the plate origin when no instance is available', () => {
    expect(slicedMeshPosition()).toEqual([0, 0, 0]);
  });
});
