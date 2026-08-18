import { describe, expect, it, vi } from 'vitest';
import type { ModelTransform } from '@slicer/client';
import { syncModelTransforms } from './syncModelTransforms';

const transform = (offset: [number, number, number]): ModelTransform => ({
  offset,
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  mirror: [1, 1, 1],
});

describe('syncModelTransforms', () => {
  it('synchronizes every composite, including sibling volumes of each instance', async () => {
    const setModelTransform = vi.fn().mockResolvedValue({ ok: true });
    const volumes = [
      { buffer: { objectIdx: 0, volumeIdx: 0, instanceIdx: 0 }, instanceTransform: transform([0, 0, 0]), volumeTransform: transform([0, 0, 0]) },
      { buffer: { objectIdx: 0, volumeIdx: 1, instanceIdx: 0 }, instanceTransform: transform([0, 0, 0]), volumeTransform: transform([1, 0, 0]) },
      { buffer: { objectIdx: 0, volumeIdx: 0, instanceIdx: 1 }, instanceTransform: transform([50, 0, 0]), volumeTransform: transform([0, 0, 0]) },
      { buffer: { objectIdx: 0, volumeIdx: 1, instanceIdx: 1 }, instanceTransform: transform([50, 0, 0]), volumeTransform: transform([1, 0, 0]) },
    ];

    await expect(syncModelTransforms({ setModelTransform }, volumes)).resolves.toEqual({ ok: true });
    expect(setModelTransform).toHaveBeenCalledTimes(4);
    expect(setModelTransform.mock.calls.map(([objectIdx, volumeIdx, instanceIdx]) => [objectIdx, volumeIdx, instanceIdx]))
      .toEqual([[0, 0, 0], [0, 1, 0], [0, 0, 1], [0, 1, 1]]);
  });
});
