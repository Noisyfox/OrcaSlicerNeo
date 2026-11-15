import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { persistSettledModelTransforms } from './persistModelTransforms';

const syncModelTransforms = vi.hoisted(() => vi.fn());
const applyPlateSessionTransforms = vi.hoisted(() => vi.fn());

vi.mock('./syncModelTransforms', () => ({
  syncModelTransforms,
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

describe('persistSettledModelTransforms', () => {
  beforeEach(() => {
    useSlicerStore.setState({
      status: 'done', progress: 100, maxLayer: 79, error: null, resultExported: true,
    });
    syncModelTransforms.mockReset();
    useProjectStore.getState().reset();
  });

  it('invalidates the slicer result after a successful transform sync', async () => {
    syncModelTransforms.mockResolvedValue({ ok: true, plateSession: plateMutation });
    const result = await persistSettledModelTransforms({} as never);
    expect(result).toEqual({ ok: true, plateSession: plateMutation });
    const slicer = useSlicerStore.getState();
    expect(slicer.status).toBe('idle');
    expect(slicer.resultExported).toBe(false);
    expect(slicer.maxLayer).toBe(-1);
    expect(slicer.progress).toBe(0);
  });

  it('keeps a completed result when the transform sync fails', async () => {
    syncModelTransforms.mockResolvedValue({ ok: false, error: 'transform failed' });
    const result = await persistSettledModelTransforms({} as never);
    expect(result).toEqual({ ok: false, error: 'transform failed' });
    expect(useSlicerStore.getState().status).toBe('done');
  });

  it('publishes one affected-plate invalidation and cancels only its active slice', async () => {
    const slicer = useSlicerStore.getState();
    slicer.invalidateSliceResult();
    for (const plateId of ['a', 'b'])
      slicer.setPlateResult({ plateId, inputStamp: 1, resultGeneration: '1', sliceTaskId: plateId }, [], {});
    useSlicerStore.setState({ status: 'slicing', activeSliceTarget: { plateId: 'a', inputRevision: 1 },
      sliceTarget: { plateId: 'b', inputRevision: 1 }, progress: 37 });
    syncModelTransforms.mockResolvedValue({ ok: true, plateSession: {
      ...plateMutation, currentPlateId: 'b', inputRevisions: { a: 2, b: 1 },
      affectedPlateIdsBefore: ['a'], affectedPlateIdsAfter: ['a'], affectedPlateIds: ['a'],
      plates: ['a', 'b'].map((plateId, displayIndex) => ({ plateId, displayIndex, name: plateId, origin: [0, 0, 0] })),
    } });
    const cancel = vi.fn(async () => ({ ok: true }));
    const runtime = { cancel, getRuntimeExecutionState: () => ({ threaded: true, sliceActive: true,
      serialSliceActive: false, serialTerminalEpoch: '0' }) };
    const publications: string[][] = [];
    const unsubscribe = useSlicerStore.subscribe((state, previous) => {
      if (state.plateResults !== previous.plateResults) publications.push(Object.keys(state.plateResults));
    });
    try {
      await persistSettledModelTransforms(runtime as never);
      expect(publications).toEqual([['b']]);
      expect(cancel).toHaveBeenCalledOnce();
      expect(useSlicerStore.getState()).toMatchObject({ status: 'done', activeSliceTarget: null,
        sliceTarget: { plateId: 'b', inputRevision: 1 } });
    } finally { unsubscribe(); }
  });

  it('projects native plate revisions without changing the history checkpoint', async () => {
    syncModelTransforms.mockResolvedValue({
      ok: true,
      plateSession: {
        ...plateMutation,
        plates: ['plate-1', 'plate-2'].map((plateId, displayIndex) => ({ plateId, displayIndex, name: plateId, origin: [0, 0, 0] })),
        inputRevisions: { 'plate-1': 4, 'plate-2': 1 },
        dirtyReasons: ['model-transform'],
        instanceTransforms: [],
      },
    });
    await persistSettledModelTransforms({} as never);
    expect(useProjectStore.getState()).toMatchObject({
      dirty: false,
    });
    expect(usePlateSessionStore.getState().snapshot?.inputRevisions).toEqual({ 'plate-1': 4, 'plate-2': 1 });
  });
});
