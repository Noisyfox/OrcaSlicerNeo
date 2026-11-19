import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { useProjectStore } from '@/stores/useProjectStore';
import type { TransformGestureResult } from './transformHistory';
import { applySettledTransformSyncResult, trackReleasedTransform, waitForSettledModelTransforms } from './persistModelTransforms';

const applyPlateSessionTransforms = vi.hoisted(() => vi.fn());

vi.mock('./syncModelTransforms', () => ({
  applyPlateSessionTransforms,
}));

const plateMutation = {
  ok: true as const, version: 1 as const, currentPlateId: 'plate-1', instances: [], plates: [], instanceTransforms: [],
  inputRevisions: { 'plate-1': 1 }, affectedPlateIdsBefore: ['plate-1'], affectedPlateIdsAfter: ['plate-1'],
  affectedPlateIds: ['plate-1'], dirtyReasons: ['model-transform'], nativeScopedConfig: {
    version: 1 as const, revision: 1, kind: 'full' as const,
    snapshot: { project: {}, objects: {}, parts: {}, plates: {} }, removedTargets: [],
  },
};

describe('applySettledTransformSyncResult', () => {
  beforeEach(() => {
    useSlicerStore.setState({
      status: 'done', progress: 100, maxLayer: 79, error: null, resultExported: true,
    });
    useProjectStore.getState().reset();
  });

  it('invalidates the slicer result after a successful transform sync', async () => {
    applySettledTransformSyncResult({ ok: true, plateSession: plateMutation }, {} as never);
    const slicer = useSlicerStore.getState();
    expect(slicer.status).toBe('idle');
    expect(slicer.resultExported).toBe(false);
    expect(slicer.maxLayer).toBe(-1);
    expect(slicer.progress).toBe(0);
  });

  it('keeps a completed result when the transform sync fails', async () => {
    applySettledTransformSyncResult({ ok: false, error: 'transform failed' }, {} as never);
    expect(useSlicerStore.getState().status).toBe('done');
  });

  it('publishes one affected-plate invalidation and cancels only its active slice', async () => {
    const slicer = useSlicerStore.getState();
    slicer.invalidateSliceResult();
    for (const plateId of ['a', 'b'])
      slicer.setPlateResult({ plateId, inputStamp: 1, resultGeneration: '1', sliceTaskId: plateId }, [], {});
    useSlicerStore.setState({ status: 'slicing', activeSliceTarget: { plateId: 'a', inputRevision: 1 },
      sliceTarget: { plateId: 'b', inputRevision: 1 }, progress: 37 });
    const cancel = vi.fn(async () => ({ ok: true }));
    const runtime = { cancel, getRuntimeExecutionState: () => ({ threaded: true, sliceActive: true,
      serialSliceActive: false, serialTerminalEpoch: '0' }) };
    const publications: string[][] = [];
    const unsubscribe = useSlicerStore.subscribe((state, previous) => {
      if (state.plateResults !== previous.plateResults) publications.push(Object.keys(state.plateResults));
    });
    try {
      applySettledTransformSyncResult({ ok: true, plateSession: {
        ...plateMutation, currentPlateId: 'b', inputRevisions: { a: 2, b: 1 },
        affectedPlateIdsBefore: ['a'], affectedPlateIdsAfter: ['a'], affectedPlateIds: ['a'],
        plates: ['a', 'b'].map((plateId, displayIndex) => ({ plateId, displayIndex, name: plateId, origin: [0, 0, 0] })),
      } }, runtime as never);
      expect(publications).toEqual([['b']]);
      expect(cancel).toHaveBeenCalledOnce();
      expect(useSlicerStore.getState()).toMatchObject({ status: 'done', activeSliceTarget: null,
        sliceTarget: { plateId: 'b', inputRevision: 1 } });
    } finally { unsubscribe(); }
  });

  it('projects native plate revisions without changing the history checkpoint', async () => {
    applySettledTransformSyncResult({
      ok: true,
      plateSession: {
        ...plateMutation,
        plates: ['plate-1', 'plate-2'].map((plateId, displayIndex) => ({ plateId, displayIndex, name: plateId, origin: [0, 0, 0] })),
        inputRevisions: { 'plate-1': 4, 'plate-2': 1 },
        dirtyReasons: ['model-transform'],
        instanceTransforms: [],
      },
    }, {} as never);
    expect(useProjectStore.getState()).toMatchObject({
      dirty: false,
    });
    expect(usePlateSessionStore.getState().snapshot?.inputRevisions).toEqual({ 'plate-1': 4, 'plate-2': 1 });
  });
});

it('waits for the releases seen by a command and reports an earlier failure once', async () => {
  let finishFirst!: (result: TransformGestureResult) => void;
  let finishSecond!: (result: TransformGestureResult) => void;
  trackReleasedTransform(new Promise(resolve => { finishFirst = resolve; }));
  const first = waitForSettledModelTransforms();
  trackReleasedTransform(new Promise(resolve => { finishSecond = resolve; }));
  const both = waitForSettledModelTransforms();
  finishFirst({ outcome: 'stale', error: 'target changed' });
  await expect(first).resolves.toEqual({ ok: false, error: 'target changed' });
  const remaining = waitForSettledModelTransforms();
  finishSecond({ outcome: 'committed' });
  await expect(both).resolves.toEqual({ ok: false, error: 'target changed' });
  await expect(remaining).resolves.toEqual({ ok: true });
  expect(waitForSettledModelTransforms()).toBeNull();
});
