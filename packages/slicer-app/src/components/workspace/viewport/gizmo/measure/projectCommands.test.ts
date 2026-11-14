import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeasureController } from './MeasureController';
import { measureMutationAllowed, registerMeasureCommands } from './projectCommands';

let unregister = () => {};
afterEach(() => { unregister(); });

describe('Measure topology admission', () => {
  it('protects the selected object, shared source part and instance without blocking unrelated targets', () => {
    const report = vi.fn();
    unregister = registerMeasureCommands({ active: true, getSnapshot: () => ({ targets: [{ objectId: 1, volumeId: 10, instanceId: 20 }] }),
      reportTargetProtected: report } as unknown as MeasureController);
    expect(measureMutationAllowed({ all: true })).toBe(false);
    expect(measureMutationAllowed({ objects: [1] })).toBe(false);
    expect(measureMutationAllowed({ parts: [10] })).toBe(false);
    expect(measureMutationAllowed({ instances: [20] })).toBe(false);
    expect(measureMutationAllowed({ objects: [2], parts: [12], instances: [21] })).toBe(true);
    expect(report).toHaveBeenCalledTimes(4);
  });

  it('does not protect anything once the session is closed', () => {
    unregister = registerMeasureCommands({ active: false } as unknown as MeasureController);
    expect(measureMutationAllowed({ all: true })).toBe(true);
  });
});
