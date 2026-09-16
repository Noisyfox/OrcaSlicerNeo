import { describe, expect, it, beforeEach } from 'vitest';
import type { PlateSessionMutation, SliceResultReceipt } from '@slicer/client';
import { useSlicerStore } from './useSlicerStore';
import { applyPlateResultMutation } from './plateResultLifecycle';

const receipt = (plateId: string, inputStamp: number, sliceTaskId = `${plateId}-${inputStamp}`): SliceResultReceipt =>
  ({ plateId, inputStamp, sliceTaskId });

describe('per-plate result lifecycle', () => {
  beforeEach(() => useSlicerStore.getState().invalidateSliceResult());

  it('restores an unchanged result and rejects a stale revision', () => {
    const store = useSlicerStore.getState();
    store.setPlateResult(receipt('a', 2));
    expect(store.activatePlateResult('a', 2)).toBe(true);
    expect(useSlicerStore.getState().status).toBe('done');
    expect(store.activatePlateResult('a', 3)).toBe(false);
    expect(useSlicerStore.getState().status).toBe('idle');
  });

  it('invalidates only affected results', () => {
    const store = useSlicerStore.getState();
    store.setPlateResult(receipt('a', 1));
    store.setPlateResult(receipt('b', 1));
    store.invalidatePlateResults(['a']);
    expect(Object.keys(useSlicerStore.getState().plateResults)).toEqual(['b']);
    expect(store.activatePlateResult('b', 1)).toBe(true);
  });

  it('preserves surviving results across reflow and drops deleted identities', () => {
    const store = useSlicerStore.getState();
    store.setPlateResult(receipt('a', 1));
    store.setPlateResult(receipt('b', 1));
    const previous = { ok: true, version: 1, currentPlateId: 'a', plates: [{ plateId: 'a' }, { plateId: 'b' }] } as unknown as PlateSessionMutation;
    const mutation = { ok: true, version: 1, currentPlateId: 'b', plates: [{ plateId: 'b' }], dirtyReasons: ['plate-structure'], inputRevisions: { b: 1 }, instanceTransforms: [] } as unknown as PlateSessionMutation;
    applyPlateResultMutation(mutation, previous);
    expect(Object.keys(useSlicerStore.getState().plateResults)).toEqual(['b']);
    expect(useSlicerStore.getState().status).toBe('done');
  });

  it('restores a cached plate warning through Preview activation', () => {
    const store = useSlicerStore.getState();
    store.setPlateResult(receipt('a', 1), ['Prime Tower intersects an exclusion area.']);
    expect(store.activatePlateResult('a', 1)).toBe(true);
    expect(useSlicerStore.getState().error).toBe('[Warning] Prime Tower intersects an exclusion area.');
  });

  it('clears a prior plate warning when activating a cached plate without warnings', () => {
    const store = useSlicerStore.getState();
    store.setPlateResult(receipt('a', 1), ['Prime Tower is outside the printable area.']);
    store.setPlateResult(receipt('b', 1));
    expect(store.activatePlateResult('a', 1)).toBe(true);
    expect(useSlicerStore.getState().error).toContain('outside the printable area');
    expect(store.activatePlateResult('b', 1)).toBe(true);
    expect(useSlicerStore.getState().error).toBeNull();
  });
});
