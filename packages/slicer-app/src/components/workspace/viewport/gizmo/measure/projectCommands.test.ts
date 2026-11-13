import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelObjectStructure } from '@slicer/client';
import { useObjectListStore } from '../../../objectList/useObjectListStore';
import type { MeasureController } from './MeasureController';
import { measureMutationAllowed, registerMeasureCommands } from './projectCommands';

const objects = [{ id: 1, index: 0, name: 'Object', printable: true, instanceCount: 2,
  volumes: [10, 11, 12].map((id, index) => ({ id, index, name: `Part ${id}`, type: 'model_part', isSplittable: true })),
  instances: [20, 21].map((id, index) => ({ id, index, printable: true })) }] as ModelObjectStructure[];
let unregister = () => {};
afterEach(() => { unregister(); useObjectListStore.getState().clear(); });

describe('Measure topology admission', () => {
  it('protects the selected object, shared source part and instance without blocking unrelated targets', () => {
    const report = vi.fn();
    unregister = registerMeasureCommands({ active: true, getSnapshot: () => ({ targets: [{ objectId: 1, volumeId: 10, instanceId: 20 }] }),
      reportTargetProtected: report } as unknown as MeasureController);
    useObjectListStore.getState().setStructure(objects);
    expect(measureMutationAllowed({ all: true })).toBe(false);
    expect(measureMutationAllowed({ objects: [1] })).toBe(false);
    expect(measureMutationAllowed({ parts: [10] })).toBe(false);
    expect(measureMutationAllowed({ instances: [20] })).toBe(false);
    expect(measureMutationAllowed({ objects: [2], parts: [12], instances: [21] })).toBe(true);
    expect(measureMutationAllowed({ parts: [11], deletingParts: true })).toBe(true);
    // Removing both siblings would normalize and re-ID the measured part.
    expect(measureMutationAllowed({ parts: [11, 12], deletingParts: true })).toBe(false);
    expect(report).toHaveBeenCalledTimes(5);
  });

  it('does not protect anything once the session is closed', () => {
    unregister = registerMeasureCommands({ active: false } as unknown as MeasureController);
    expect(measureMutationAllowed({ all: true })).toBe(true);
  });
});
