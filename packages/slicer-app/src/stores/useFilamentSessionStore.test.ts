import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFilamentSessionStore } from './useFilamentSessionStore';
import { useSlicerStore } from './useSlicerStore';
import type { FilamentSessionSnapshot, HistoryStatus, SlicerClient } from '@slicer/client';
import { useHistoryNavigationStore } from './useHistoryNavigationStore';
import { useProjectStore } from './useProjectStore';

function snapshot(revision: number): FilamentSessionSnapshot {
  return {
    ok: true, version: 1, slots: [{ slot: 1, preset: { id: 'a', name: `PLA ${revision}` }, colour: { effective: '#112233', provenance: 'preset' } }],
    mappings: { filament: [1], volume: [0], nozzle: [1], filament2: [1], physicalExtruder: [0] },
    flushing: { matrix: [0], vector: [0], matrixDimension: 1, planeCount: 1, source: 'native' },
    capabilities: { minSlots: 1, maxSlots: 8, nozzleCount: 1, flexible: true, canAdd: true, canDelete: true, canMerge: true },
    assignments: { objects: [], parts: [], modifiers: [] },
    revisions: { session: revision, project: revision, result: 0, plates: {} }, status: { state: 'ready', error: null },
  };
}

function historyStatus(revision: number, dirty = true): HistoryStatus {
  return {
    canUndo: dirty, canRedo: false, undoEntries: [], redoEntries: [], cursor: revision,
    savedCheckpoint: 0, savedCheckpointEvicted: false, dirty, bytesUsed: 1,
    byteBudget: 10, optionalBytesReleased: 0, evictedEntryCount: 0,
    lastEvictedEntryId: null, oldestRetainedEntryId: 'entry-0', oversizedEntryRetained: false,
    disabled: false, activeTransactionId: null, revision,
  };
}

afterEach(() => {
  useFilamentSessionStore.getState().reset();
  useHistoryNavigationStore.getState().setStatus(null);
  useProjectStore.getState().setProject({ dirty: false, dirtyReasons: [] });
});

describe('filament session store lifecycle', () => {
  it('publishes only a current complete Worker snapshot', async () => {
    const initial = snapshot(1); const newer = snapshot(2);
    const runtime = { getFilamentSessionSnapshot: vi.fn(async () => newer) } as unknown as SlicerClient;
    useFilamentSessionStore.setState({ snapshot: initial, rejected: null });
    await useFilamentSessionStore.getState().refresh(runtime, () => false);
    expect(useFilamentSessionStore.getState().snapshot).toBe(initial);
    await useFilamentSessionStore.getState().refresh(runtime, () => true);
    expect(useFilamentSessionStore.getState().snapshot).toBe(newer);
  });

  it('fences a filament command behind a project refresh and reads the refreshed revision', async () => {
    const initial = snapshot(1);
    const refreshed = snapshot(2);
    const assigned = snapshot(3);
    let releaseRefresh!: (value: FilamentSessionSnapshot) => void;
    const runtime = {
      getFilamentSessionSnapshot: vi.fn(() => new Promise<FilamentSessionSnapshot>((resolve) => { releaseRefresh = resolve; })),
    } as unknown as SlicerClient;
    useFilamentSessionStore.setState({ snapshot: initial, rejected: null });
    const refresh = useFilamentSessionStore.getState().refresh(runtime);
    const command = vi.fn(async () => ({ ok: true as const, version: 1 as const, result: {
      snapshot: assigned,
      mutation: { kind: 'assign' as const, historyEntryDelta: 1 as const, revisionBefore: 2, revisionAfter: 3,
        dirty: true as const, allPlateResultsInvalidated: false as const, affectedPlateIds: [] },
      historyStatus: historyStatus(3),
    } }));
    const run = useFilamentSessionStore.getState().run(runtime, command);
    expect(command).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    releaseRefresh(refreshed);
    await refresh;
    await run;
    expect(command).toHaveBeenCalledOnce();
    expect(useFilamentSessionStore.getState().snapshot).toBe(assigned);
  });

  it('replaces the mirror only from a successful returned mutation', async () => {
    const initial = snapshot(1); const newer = snapshot(3);
    const runtime = {} as SlicerClient;
    useFilamentSessionStore.setState({ snapshot: initial, rejected: null });
    await useFilamentSessionStore.getState().run(runtime, async () => ({ ok: false, version: 1, error: 'rejected', errorCode: 'native_validation_failure' }));
    expect(useFilamentSessionStore.getState().snapshot).toBe(initial);
    await useFilamentSessionStore.getState().run(runtime, async () => ({ ok: true, version: 1, result: {
      snapshot: newer,
      mutation: { kind: 'add', historyEntryDelta: 1, revisionBefore: 1, revisionAfter: 3, dirty: true, allPlateResultsInvalidated: true },
      historyStatus: historyStatus(3),
    } }));
    expect(useFilamentSessionStore.getState().snapshot).toBe(newer);
    expect(useHistoryNavigationStore.getState().status).toEqual(historyStatus(3));
    expect(useProjectStore.getState().dirty).toBe(true);
  });

  it('invalidates shared rack results and cancels only an affected active plate', async () => {
    const initial = snapshot(1); const newer = snapshot(2);
    const result = { ok: true as const, version: 1 as const, result: {
      snapshot: newer,
      mutation: { kind: 'set-colour' as const, historyEntryDelta: 1 as const, revisionBefore: 1, revisionAfter: 2,
        dirty: true as const, allPlateResultsInvalidated: true as const },
      historyStatus: historyStatus(2),
    } };
    const cancel = vi.fn(async () => ({ ok: true }));
    const slicer = useSlicerStore.getState();
    slicer.setPlateResult({ plateId: 'plate-a', inputRevision: 1 }, {
      ok: true, objects: 1, layers: 1,
      toolpath: { features: new Uint32Array(), palette: [], segmentCount: 0,
        starts: new Float32Array(), ends: new Float32Array(), layerIds: new Uint32Array(), moveOrders: new Uint32Array(), gcodeIds: new Uint32Array(),
        sourceLineOrderValid: true, moveTypes: new Uint8Array(), extrusionRoles: new Uint16Array(), extruderIds: new Uint8Array(), colorPrintIds: new Uint8Array(),
        widths: new Float32Array(), heights: new Float32Array(), metrics: {} },
      metadata: { resultId: 1, layerRanges: [], featurePalette: [] },
    });
    slicer.setActiveSliceTarget({ plateId: 'plate-a', inputRevision: 1 });
    slicer.setStatus('slicing');
    useFilamentSessionStore.setState({ snapshot: initial, rejected: null });
    await useFilamentSessionStore.getState().run({ cancel } as unknown as SlicerClient, async () => result);
    expect(useSlicerStore.getState().plateResults).toEqual({});
    expect(useSlicerStore.getState().activeSliceTarget).toBeNull();
    expect(useSlicerStore.getState().status).toBe('idle');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('retains an unaffected cached plate for an object-scoped mutation', async () => {
    const initial = snapshot(1); const newer = snapshot(2);
    const slicer = useSlicerStore.getState();
    const emptyResult = { ok: true, objects: 1, layers: 1,
      toolpath: { features: new Uint32Array(), palette: [], segmentCount: 0,
        starts: new Float32Array(), ends: new Float32Array(), layerIds: new Uint32Array(), moveOrders: new Uint32Array(), gcodeIds: new Uint32Array(),
        moveTypes: new Uint8Array(), extrusionRoles: new Uint16Array(), extruderIds: new Uint8Array(), colorPrintIds: new Uint8Array(), widths: new Float32Array(), heights: new Float32Array(), metrics: {} },
      metadata: { resultId: 1, layerRanges: [], featurePalette: [] } };
    slicer.setPlateResult({ plateId: 'plate-a', inputRevision: 1 }, emptyResult);
    slicer.setPlateResult({ plateId: 'plate-b', inputRevision: 1 }, emptyResult);
    useFilamentSessionStore.setState({ snapshot: initial, rejected: null });
    await useFilamentSessionStore.getState().run({} as SlicerClient, async () => ({ ok: true, version: 1, result: {
      snapshot: newer,
      mutation: { kind: 'assign', historyEntryDelta: 1, revisionBefore: 1, revisionAfter: 2, dirty: true, allPlateResultsInvalidated: false, affectedPlateIds: ['plate-a'] },
      historyStatus: historyStatus(2),
    } }));
    expect(Object.keys(useSlicerStore.getState().plateResults)).toEqual(['plate-b']);
  });

  it('preserves the last complete snapshot and records thrown refresh failures', async () => {
    const initial = snapshot(7);
    const runtime = { getFilamentSessionSnapshot: vi.fn(async () => { throw new Error('worker unavailable'); }) } as unknown as SlicerClient;
    useFilamentSessionStore.setState({ snapshot: initial, rejected: null });

    const result = await useFilamentSessionStore.getState().refresh(runtime);

    expect(result).toMatchObject({ ok: false, error: 'worker unavailable', errorCode: 'runtime_failure' });
    expect(useFilamentSessionStore.getState().snapshot).toBe(initial);
    expect(useFilamentSessionStore.getState().rejected).toBe('worker unavailable');
  });

  it('preserves the last complete snapshot when the Worker rejects a refresh', async () => {
    const initial = snapshot(8);
    const runtime = { getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false, version: 1, error: 'replacement unavailable', errorCode: 'runtime_unavailable' })) } as unknown as SlicerClient;
    useFilamentSessionStore.setState({ snapshot: initial, rejected: null });

    const result = await useFilamentSessionStore.getState().refresh(runtime);

    expect(result.ok).toBe(false);
    expect(useFilamentSessionStore.getState().snapshot).toBe(initial);
    expect(useFilamentSessionStore.getState().rejected).toBe('replacement unavailable');
  });
});
