import { describe, expect, it } from 'vitest';
import type { ModelObjectStructure } from '@slicer/client';
import { selectedAutoDropObjects } from './autoDrop';

const objects: ModelObjectStructure[] = [0, 1, 2].map((index) => ({
  id: index + 1, index, name: `Object ${index}`, printable: true, autoDrop: index !== 1, instanceCount: 1,
  volumes: [{ id: 10 + index, index: 0, name: 'Part', type: 'model_part', isSplittable: false }],
  instances: [{ id: 20 + index, index: 0, printable: true }],
}));

describe('Auto Drop selection', () => {
  it('deduplicates objects selected through objects, instances and parts', () => {
    const selected = selectedAutoDropObjects(objects, {
      objectIds: new Set([1]), instanceIds: new Set([20, 21]), volumeIds: new Set([11, 12]),
    });
    expect(selected.map((object) => object.id)).toEqual([1, 2, 3]);
    expect(selected.every((object) => object.autoDrop)).toBe(false);
  });
});
