import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFilamentSessionStore } from './useFilamentSessionStore';
import { useSlicerStore } from './useSlicerStore';
import type { FilamentSessionSnapshot, HistoryStatus, ModelObjectStructure, PlateSessionSnapshot, SlicerClient } from '@slicer/client';
import { useHistoryNavigationStore } from './useHistoryNavigationStore';
import { useProjectStore } from './useProjectStore';
import { usePlateSessionStore } from './usePlateSessionStore';
import { useObjectListStore } from '../components/workspace/objectList/useObjectListStore';
import { glVolumeCollection, retainedPaintGeometry } from '../components/workspace/viewport/GLVolume';
import { projectFullModelMesh } from '../components/workspace/viewport/modelMeshProjection';

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
    byteBudget: 10, evictedEntryCount: 0,
    lastEvictedEntryId: null, oldestRetainedEntryId: 'entry-0', oversizedEntryRetained: false,
    disabled: false, activeTransactionId: null, revision,
  };
}

afterEach(() => {
  useFilamentSessionStore.getState().reset();
  usePlateSessionStore.getState().reset();
  useHistoryNavigationStore.getState().setStatus(null);
  useProjectStore.getState().setProject({ dirty: false, dirtyReasons: [] });
  glVolumeCollection.clear();
  useObjectListStore.getState().clear();
});

describe('filament session store lifecycle', () => {
  it.each(['delete', 'merge'] as const)('refreshes painted models on two plates after a %s mutation', async (kind) => {
    const transform = { offset: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number], mirror: [1, 1, 1] as [number, number, number] };
    const structures: ModelObjectStructure[] = [10, 20].map((id, index) => ({
      id, index, name: `object-${id}`, printable: true, instanceCount: 1,
      volumes: [{ id: id + 100, index: 0, name: 'part', type: 'model_part', isSplittable: false }],
      instances: [{ id: id + 200, index: 0, printable: true }],
    }));
    const original = [10, 20].map((id, objectIdx) => ({
      objectId: id, volumeId: id + 100, instanceId: id + 200, objectIdx, volumeIdx: 0, instanceIdx: 0,
      geometryKey: `original:${id}`, paintGeometryKey: `paint:${id}:before`,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]),
      vertexCount: 3, indexCount: 3, offset: [0, 0, 0] as [number, number, number],
      instanceTransform: transform, volumeTransform: transform,
    }));
    const paint = (id: number, version: string) => ({
      paintGeometryKey: `paint:${id}:${version}`, volumeId: id + 100,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]),
      vertexCount: 3, indexCount: 3,
      drawGroups: [{ stateId: version === 'before' ? 2 : 1, startIndex: 0, indexCount: 3 }],
    });
    useObjectListStore.getState().setStructure(structures);
    glVolumeCollection.replace(projectFullModelMesh({ ok: true, objects: original,
      paintGeometries: [paint(10, 'before'), paint(20, 'before')] }));
    const beforeOriginal = glVolumeCollection.volumes.map((volume) => volume.geometry);
    const getModelScenePatch = vi.fn(async (ids: number[], knownOriginal: string[], knownPaint: string[]) => ({
      ok: true, objectOrder: [10, 20], objects: structures,
      meshes: original.map((mesh) => ({ ...mesh, paintGeometryKey: `paint:${mesh.objectId}:after` })),
      geometries: [], paintGeometries: [paint(10, 'after'), paint(20, 'after')],
    }));
    const runtime = { getModelScenePatch } as unknown as SlicerClient;
    useFilamentSessionStore.setState({ snapshot: snapshot(1) });
    const result = await useFilamentSessionStore.getState().run(runtime, async () => ({
      ok: true as const, version: 1 as const, result: {
        snapshot: snapshot(2), historyStatus: historyStatus(2), mutation: {
          kind, source: 2, destination: kind === 'merge' ? 1 : null,
          historyEntryDelta: 1 as const, revisionBefore: 1, revisionAfter: 2, dirty: true as const,
          allPlateResultsInvalidated: true, affectedPlateIds: ['plate-a', 'plate-b'],
        },
      },
    }));
    expect(result.ok).toBe(true);
    expect(getModelScenePatch).toHaveBeenCalledWith([10, 20], ['original:10', 'original:20'],
      ['paint:10:before', 'paint:20:before']);
    expect(glVolumeCollection.volumes.map((volume) => volume.paintGeometryKey))
      .toEqual(['paint:10:after', 'paint:20:after']);
    glVolumeCollection.volumes.forEach((volume, index) => expect(volume.geometry).toBe(beforeOriginal[index]));
    expect(glVolumeCollection.volumes.map((volume) => volume.paintDrawGroups[0]?.stateId)).toEqual([1, 1]);
    expect(retainedPaintGeometry('paint:10:before')).toBeUndefined();
    expect(retainedPaintGeometry('paint:20:before')).toBeUndefined();
    expect(useFilamentSessionStore.getState().snapshot?.revisions.session).toBe(2);
  });

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
      mutation: { kind: 'add', historyEntryDelta: 1, revisionBefore: 1, revisionAfter: 3, dirty: true, allPlateResultsInvalidated: true, affectedPlateIds: ['plate-a'] },
      historyStatus: historyStatus(3),
    } }));
    expect(useFilamentSessionStore.getState().snapshot).toBe(newer);
    expect(useHistoryNavigationStore.getState().status).toEqual(historyStatus(3));
    expect(useProjectStore.getState().dirty).toBe(true);
  });

  it('projects filament receipt plate revisions before a Prime Tower move can read them', async () => {
    const initial = snapshot(1);
    const newer = {
      ...snapshot(2),
      revisions: { session: 2, project: 2, result: 0, plates: { 'plate-a': 2, 'plate-b': 1 } },
    };
    const plateSession: PlateSessionSnapshot = {
      instances: [],
      ok: true, version: 1, currentPlateId: 'plate-a',
      plates: [
        { plateId: 'plate-a', displayIndex: 0, origin: [0, 0, 0], name: 'Plate A' },
        { plateId: 'plate-b', displayIndex: 1, origin: [250, 0, 0], name: 'Plate B' },
      ],
      inputRevisions: { 'plate-a': 1, 'plate-b': 1 },
    };
    useFilamentSessionStore.setState({ snapshot: initial, rejected: null });
    usePlateSessionStore.getState().setSnapshot(plateSession);

    await useFilamentSessionStore.getState().run({} as SlicerClient, async () => ({ ok: true, version: 1, result: {
      snapshot: newer,
      mutation: { kind: 'assign', historyEntryDelta: 1, revisionBefore: 1, revisionAfter: 2,
        dirty: true, allPlateResultsInvalidated: false, affectedPlateIds: ['plate-a'] },
      historyStatus: historyStatus(2),
    } }));

    // WipeTowerVolumeCollection's move port obtains this exact value at
    // pointer-up while it owns the same FIFO as the preceding assignment.
    expect(usePlateSessionStore.getState().snapshot?.inputRevisions).toEqual({ 'plate-a': 2, 'plate-b': 1 });
  });

  it('invalidates shared rack results and cancels only an affected active plate', async () => {
    const initial = snapshot(1); const newer = snapshot(2);
    const result = { ok: true as const, version: 1 as const, result: {
      snapshot: newer,
      mutation: { kind: 'set-colour' as const, historyEntryDelta: 1 as const, revisionBefore: 1, revisionAfter: 2,
        dirty: true as const, allPlateResultsInvalidated: true as const, affectedPlateIds: ['plate-a'] },
      historyStatus: historyStatus(2),
    } };
    const cancel = vi.fn(async () => ({ ok: true }));
    const slicer = useSlicerStore.getState();
    slicer.setPlateResult({ plateId: 'plate-a', inputStamp: 1, resultGeneration: '1', sliceTaskId: '1' });
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
    slicer.setPlateResult({ plateId: 'plate-a', inputStamp: 1, resultGeneration: '1', sliceTaskId: '1' });
    slicer.setPlateResult({ plateId: 'plate-b', inputStamp: 1, resultGeneration: '1', sliceTaskId: '2' });
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
