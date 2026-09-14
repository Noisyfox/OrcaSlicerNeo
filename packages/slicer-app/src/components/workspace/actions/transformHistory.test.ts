import * as THREE from 'three';
import type { ModelObjectBuffer } from '@slicer/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneInteractionController } from '../viewport/SceneInteractionController';
import { GLVolume, glVolumeCollection } from '../viewport/GLVolume';
import { TransformHistoryCoordinator } from './transformHistory';
import { runProjectMutationOperation } from './historyMutation';
import { useObjectListStore } from '../objectList/useObjectListStore';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import { useFilamentSessionStore } from '../../../stores/useFilamentSessionStore';
import { useHistoryNavigationStore } from '../../../stores/useHistoryNavigationStore';

function makeVolume(objectIdx: number, volumeIdx: number, instanceIdx: number): GLVolume {
  const buffer: ModelObjectBuffer = {
    objectIdx,
    volumeIdx,
    instanceIdx,
    positions: new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1, -1]),
    vertexCount: 3,
    indices: new Uint32Array([0, 1, 2]),
    indexCount: 3,
    offset: [0, 0, 0],
    instanceTransform: { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] },
    volumeTransform: { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] },
  };
  return new GLVolume(buffer);
}

const emptyProjection = {
  getModelStructure: vi.fn(async () => structureFor(glVolumeCollection.volumes)),
  getPlateSessionSnapshot: vi.fn(async () => ({
    ok: true as const, version: 1 as const, currentPlateId: 'plate-1', plates: [],
  })),
};

function structureFor(volumes: readonly GLVolume[]) {
  const objects = new Map<number, {
    id: number; index: number; name: string; printable: boolean; instanceCount: number;
    volumes: { id: number; index: number; name: string; type: 'model_part'; isSplittable: boolean }[];
    instances: { id: number; index: number; printable: boolean }[];
  }>();
  for (const volume of volumes) {
    const object = objects.get(volume.buffer.objectIdx) ?? {
      id: 100 + volume.buffer.objectIdx, index: volume.buffer.objectIdx, name: 'Object', printable: true,
      instanceCount: 0, volumes: [], instances: [],
    };
    if (!objects.has(volume.buffer.objectIdx)) objects.set(volume.buffer.objectIdx, object);
    if (!object.volumes.some((entry) => entry.index === volume.buffer.volumeIdx))
      object.volumes.push({ id: 200 + volume.buffer.volumeIdx, index: volume.buffer.volumeIdx, name: 'Part', type: 'model_part', isSplittable: false });
    if (!object.instances.some((entry) => entry.index === volume.buffer.instanceIdx))
      object.instances.push({ id: 300 + volume.buffer.instanceIdx, index: volume.buffer.instanceIdx, printable: true });
    object.instanceCount = object.instances.length;
  }
  return { ok: true as const, objects: [...objects.values()] };
}

function historyRuntime() {
  return {
    ...emptyProjection,
    setModelTransforms: vi.fn(async (..._args: unknown[]) => ({ ok: true, plateSession: { ok: true, version: 1, currentPlateId: 'plate-1', plates: [], instanceTransforms: [] } })),
    getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false, error: 'unused' })),
    getHistoryStatus: vi.fn(async () => ({ dirty: false, revision: 1 } as never)),
    runProjectHistoryTransaction: vi.fn(async (
      _label: string,
      _category: 'project' | 'context',
      _before: unknown,
      mutation: (tx: string) => Promise<unknown>,
      _after: unknown | (() => unknown),
    ) => ({ result: await mutation('tx-1'), status: { dirty: true } as never })),
  };
}

describe('TransformHistoryCoordinator', () => {
  beforeEach(() => {
    glVolumeCollection.clear();
    useObjectListStore.getState().clear();
    usePlateSessionStore.getState().setSnapshot(null);
    useProjectStore.getState().reset();
    useFilamentSessionStore.getState().reset();
  });

  it('keeps pointer-down reservation-only and opens the Worker transaction on release', async () => {
    let releaseMutation!: () => void;
    const mutationRelease = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const runtime = {
      setModelTransforms: vi.fn(async () => ({ ok: true })),
      getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false, error: 'unused' })),
      getHistoryStatus: vi.fn(async () => ({ dirty: false, revision: 1 } as never)),
      ...emptyProjection,
      runProjectHistoryTransaction: vi.fn(async (
        _label: string,
        _category: 'project' | 'context',
        _before: unknown,
        mutation: (tx: string) => Promise<unknown>,
        after: unknown | (() => unknown),
      ) => {
        const result = await mutation('tx-1');
        await mutationRelease;
        return { result, status: {
          dirty: true,
          canUndo: true,
          canRedo: false,
          undoEntries: [],
          redoEntries: [],
          cursor: 1,
          savedCheckpoint: 0,
          savedCheckpointEvicted: false,
          bytesUsed: 0,
          byteBudget: 256 * 1024 * 1024,
          disabled: false,
          activeTransactionId: null,
          revision: 1,
        } };
      }),
    };
    const volume = makeVolume(0, 0, 0);
    glVolumeCollection.replace([volume]);
    const controller = new SceneInteractionController(() => [volume]);
    const history = new TransformHistoryCoordinator(runtime as never, controller);
    expect(history.begin('Move')).toBe(true);
    expect(runtime.runProjectHistoryTransaction).not.toHaveBeenCalled();
    expect(runtime.setModelTransforms).not.toHaveBeenCalled();
    const commit = history.commit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.runProjectHistoryTransaction).toHaveBeenCalledTimes(1);
    releaseMutation();
    await commit;
    expect(runtime.setModelTransforms).toHaveBeenCalledTimes(1);
  });

  it('aborts a cancelled transaction without writing transforms', async () => {
    const runtime = {
      setModelTransforms: vi.fn(async () => ({ ok: true })),
      getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false, error: 'unused' })),
      getHistoryStatus: vi.fn(async () => ({ dirty: false, revision: 1 } as never)),
      ...emptyProjection,
      runProjectHistoryTransaction: vi.fn(async (
        _label: string,
        _category: 'project' | 'context',
        _before: unknown,
        mutation: (tx: string) => Promise<unknown>,
        _after: unknown | (() => unknown),
      ) => ({ result: await mutation('tx-1'), status: {} as never })),
    };
    const volume = makeVolume(0, 0, 0);
    glVolumeCollection.replace([volume]);
    const controller = new SceneInteractionController(() => [volume]);
    const history = new TransformHistoryCoordinator(runtime as never, controller);
    history.begin('Rotate');
    await history.abort();
    expect(runtime.setModelTransforms).not.toHaveBeenCalled();
  });

  it('serializes rapid discrete commands until each Worker transaction settles', async () => {
    const started: string[] = [];
    const runtime = {
      setModelTransforms: vi.fn(async () => ({ ok: true })),
      getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false, error: 'unused' })),
      getHistoryStatus: vi.fn(async () => ({ dirty: false, revision: 1 } as never)),
      ...emptyProjection,
      runProjectHistoryTransaction: vi.fn(async (
        label: string,
        _category: 'project' | 'context',
        _before: unknown,
        mutation: (tx: string) => Promise<unknown>,
        _after: unknown | (() => unknown),
      ) => {
        started.push(label);
        const result = await mutation(`tx-${started.length}`);
        return { result, status: {} as never };
      }),
    };
    const volume = makeVolume(0, 0, 0);
    glVolumeCollection.replace([volume]);
    const controller = new SceneInteractionController(() => [volume]);
    const history = new TransformHistoryCoordinator(runtime as never, controller);

    history.begin('Move');
    const firstCommit = history.commit();
    history.begin('Rotate');
    const secondCommit = history.commit();

    // Each released command enters the same FIFO and has its own final batch.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(['Move', 'Rotate']);
    await firstCommit;
    await secondCommit;
    expect(started).toEqual(['Move', 'Rotate']);
  });

  it('captures a later rapid command only after the prior release advances the native revision', async () => {
    const volume = makeVolume(0, 0, 0);
    glVolumeCollection.replace([volume]);
    let revision = 1;
    const runtime = {
      ...emptyProjection,
      getHistoryStatus: vi.fn(async () => ({ dirty: false, revision } as never)),
      getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false, error: 'unused' })),
      setModelTransforms: vi.fn(async () => ({ ok: true })),
      runProjectHistoryTransaction: vi.fn(async (
        _label: string,
        _category: 'project' | 'context',
        _before: unknown,
        mutation: (tx: string) => Promise<unknown>,
      ) => {
        const result = await mutation(`tx-${revision}`);
        revision += 1;
        return { result, status: { dirty: true, revision } as never };
      }),
    };
    const history = new TransformHistoryCoordinator(runtime as never, new SceneInteractionController(() => [volume]));

    history.begin('Move');
    volume.instanceTransform = { ...volume.instanceTransform, offset: [4, 0, 0] };
    const first = history.commit();
    history.begin('Rotate');
    volume.instanceTransform = { ...volume.instanceTransform, offset: [8, 0, 0] };
    const second = history.commit();

    await expect(first).resolves.toEqual({ outcome: 'committed' });
    await expect(second).resolves.toEqual({ outcome: 'committed' });
    expect(runtime.runProjectHistoryTransaction).toHaveBeenCalledTimes(2);
    expect(runtime.setModelTransforms.mock.calls.map((call) =>
      // The mock is intentionally narrowed by the fixture; read its runtime
      // call tuple here because the production method takes transactionId plus
      // the complete snapshot payload.
      (Array.from(call)[1] as unknown as { instanceTransform: { offset: number[] } }[])[0]?.instanceTransform.offset,
    )).toEqual([[4, 0, 0], [8, 0, 0]]);
  });

  it('writes one final stable transform per rendered CompositeID on commit', async () => {
    const volumes = [makeVolume(0, 0, 0), makeVolume(0, 1, 0), makeVolume(1, 0, 0)];
    glVolumeCollection.replace(volumes);
    const runtime = historyRuntime();
    const controller = new SceneInteractionController(() => volumes);
    const history = new TransformHistoryCoordinator(runtime as never, controller);
    controller.setTransformHistoryPort(history);
    controller.selectFromHit(volumes[0], false);

    expect(controller.tryBeginBodyDrag()).toBe(true);
    controller.updateDragPivot(new THREE.Vector3(2, 0, 0));
    controller.updateDragPivot(new THREE.Vector3(5, 0, 0));
    expect(runtime.setModelTransforms).not.toHaveBeenCalled();

    expect(controller.endDrag()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.setModelTransforms).toHaveBeenCalledTimes(1);
    expect(runtime.setModelTransforms.mock.calls[0]?.[0]).toBe('tx-1');
    expect(runtime.setModelTransforms.mock.calls[0]?.[1]).toEqual(volumes.map((volume) => ({
      objectIdx: volume.buffer.objectIdx, volumeIdx: volume.buffer.volumeIdx, instanceIdx: volume.buffer.instanceIdx,
      instanceTransform: volume.instanceTransform, volumeTransform: volume.volumeTransform,
    })));
  });

  it('aborts a no-op drag without any Worker transform writes', async () => {
    const volumes = [makeVolume(0, 0, 0)];
    glVolumeCollection.replace(volumes);
    const runtime = historyRuntime();
    const controller = new SceneInteractionController(() => volumes);
    const history = new TransformHistoryCoordinator(runtime as never, controller);
    const port = {
      begin: vi.fn((label: string) => history.begin(label)),
      commit: vi.fn(() => history.commit()),
      abort: vi.fn(() => history.abort()),
    };
    controller.setTransformHistoryPort(port);
    controller.selectFromHit(volumes[0], false);
    expect(controller.tryBeginBodyDrag()).toBe(true);
    expect(controller.updateDragPivot(controller.selectionPivot()!)).toBe(true);
    expect(controller.endDrag()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(port.abort).toHaveBeenCalledTimes(1);
    expect(port.commit).not.toHaveBeenCalled();
    expect(runtime.setModelTransforms).not.toHaveBeenCalled();
  });

  it('projects the authoritative Move status and preserves one history entry', async () => {
    const status = {
      dirty: true,
      canUndo: true,
      canRedo: false,
      undoEntries: [{ id: 'move-1', label: 'Move', category: 'project' }],
      redoEntries: [],
      cursor: 1,
      savedCheckpoint: 0,
      savedCheckpointEvicted: false,
      bytesUsed: 1,
      byteBudget: 256 * 1024 * 1024,
      disabled: false,
      activeTransactionId: null,
      revision: 1,
    } as never;
    const runtime = {
      setModelTransforms: vi.fn(async () => ({ ok: true })),
      getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false, error: 'unused' })),
      getHistoryStatus: vi.fn(async () => ({ dirty: false, revision: 1 } as never)),
      ...emptyProjection,
      runProjectHistoryTransaction: vi.fn(async (
        _label: string,
        _category: 'project' | 'context',
        _before: unknown,
        mutation: (tx: string) => Promise<unknown>,
        _after: unknown | (() => unknown),
      ) => ({ result: await mutation('tx-1'), status })),
    };
    const volume = makeVolume(0, 0, 0);
    glVolumeCollection.replace([volume]);
    const history = new TransformHistoryCoordinator(runtime as never, new SceneInteractionController(() => [volume]));

    history.begin('Move');
    await history.commit();

    expect(runtime.runProjectHistoryTransaction).toHaveBeenCalledOnce();
    expect(useHistoryNavigationStore.getState().status).toEqual(status);
    expect(useProjectStore.getState().dirty).toBe(true);
    expect(useHistoryNavigationStore.getState().status?.undoEntries).toHaveLength(1);
  });

  it('refreshes the filament revision before releasing the project fence', async () => {
    const snapshots = [{ pending: 0, revision: 2 }];
    const runtime = {
      ...emptyProjection,
      setModelTransforms: vi.fn(async () => ({ ok: true })),
      getHistoryStatus: vi.fn(async () => ({ dirty: false, revision: 1 } as never)),
      getFilamentSessionSnapshot: vi.fn(async () => {
        snapshots[0].pending = useProjectStore.getState().projectMutationPendingCount;
        return {
          ok: true,
          version: 1,
          slots: [],
          mappings: {},
          flushing: {},
          capabilities: {},
          assignments: { objects: [], parts: [], modifiers: [] },
          revisions: { session: snapshots[0].revision, project: snapshots[0].revision, result: 0, plates: {} },
          status: { state: 'ready', error: null },
        } as never;
      }),
      runProjectHistoryTransaction: vi.fn(async (
        _label: string,
        _category: 'project' | 'context',
        _before: unknown,
        mutation: (tx: string) => Promise<unknown>,
        _after: unknown | (() => unknown),
      ) => ({ result: await mutation('tx-1'), status: { dirty: true, revision: 2 } as never })),
    };
    const volume = makeVolume(0, 0, 0);
    glVolumeCollection.replace([volume]);
    const controller = new SceneInteractionController(() => [volume]);
    const history = new TransformHistoryCoordinator(runtime as never, controller);

    history.begin('Move');
    expect(useProjectStore.getState().projectMutationPendingCount).toBe(0);
    await history.commit();

    expect(runtime.getFilamentSessionSnapshot).toHaveBeenCalledOnce();
    expect(snapshots[0].pending).toBe(1);
    expect(useFilamentSessionStore.getState().snapshot?.revisions.session).toBe(2);
    expect(useProjectStore.getState().projectMutationPendingCount).toBe(0);
  });

  it('reconciles Worker authority after rejection, timeout, or a cancelled draft', async () => {
    const volume = makeVolume(0, 0, 0);
    glVolumeCollection.replace([volume]);
    const reconcile = vi.fn(async () => undefined);
    const onError = vi.fn();
    const runtime = historyRuntime();
    runtime.setModelTransforms.mockResolvedValue({ ok: false, error: 'second target rejected' } as never);
    const history = new TransformHistoryCoordinator(runtime as never,
      new SceneInteractionController(() => [volume]), onError, reconcile);

    history.begin('Move');
    await history.commit();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(useProjectStore.getState().projectMutationPendingCount).toBe(0);

    history.begin('Move');
    await history.abort();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().projectMutationPendingCount).toBe(0);

    runtime.setModelTransforms.mockRejectedValueOnce(new Error('worker timeout'));
    history.begin('Move');
    await history.commit();
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(useProjectStore.getState().projectMutationPendingCount).toBe(0);
  });

  it('does not block filament, Prime Tower, or ordinary mutations during a long draft, then rejects the stale release without a write', async () => {
    const volume = makeVolume(0, 0, 0);
    glVolumeCollection.replace([volume]);
    let revision = 1;
    const interleaved: string[] = [];
    const reconcile = vi.fn(async () => undefined);
    const runtime = {
      ...emptyProjection,
      getHistoryStatus: vi.fn(async () => ({ dirty: false, revision } as never)),
      getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false, error: 'unused' })),
      setModelTransforms: vi.fn(async () => ({ ok: true })),
      runProjectHistoryTransaction: vi.fn(async () => ({ result: { ok: true }, status: { revision } })),
    };
    const history = new TransformHistoryCoordinator(runtime as never,
      new SceneInteractionController(() => [volume]), undefined, reconcile);

    expect(history.begin('Move')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const name of ['filament', 'Prime Tower', 'ordinary project mutation']) {
      await runProjectMutationOperation(async () => {
        interleaved.push(name);
        revision += 1;
      });
    }
    expect(interleaved).toEqual(['filament', 'Prime Tower', 'ordinary project mutation']);
    volume.instanceTransform = { ...volume.instanceTransform, offset: [12, 0, 0] };

    await expect(history.commit()).resolves.toMatchObject({ outcome: 'stale' });
    expect(runtime.runProjectHistoryTransaction).not.toHaveBeenCalled();
    expect(runtime.setModelTransforms).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it('rejects an identity-invalidated reservation even if its revision was not advanced', async () => {
    const volume = makeVolume(0, 0, 0);
    glVolumeCollection.replace([volume]);
    let staleIdentity = false;
    const reconcile = vi.fn(async () => undefined);
    const runtime = {
      ...emptyProjection,
      getHistoryStatus: vi.fn(async () => ({ dirty: false, revision: 1 } as never)),
      getModelStructure: vi.fn(async () => {
        const structure = structureFor(glVolumeCollection.volumes);
        if (staleIdentity) structure.objects[0]!.instances[0]!.id = 999;
        return structure;
      }),
      getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false, error: 'unused' })),
      setModelTransforms: vi.fn(async () => ({ ok: true })),
      runProjectHistoryTransaction: vi.fn(async () => ({ result: { ok: true }, status: { revision: 1 } })),
    };
    const history = new TransformHistoryCoordinator(runtime as never,
      new SceneInteractionController(() => [volume]), undefined, reconcile);

    history.begin('Move');
    await new Promise((resolve) => setTimeout(resolve, 0));
    staleIdentity = true;
    volume.instanceTransform = { ...volume.instanceTransform, offset: [6, 0, 0] };

    await expect(history.commit()).resolves.toMatchObject({ outcome: 'stale' });
    expect(runtime.runProjectHistoryTransaction).not.toHaveBeenCalled();
    expect(runtime.setModelTransforms).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it('does not leak the project fence when context setup throws', () => {
    const controller = new SceneInteractionController(() => { throw new Error('scene projection failed'); });
    const history = new TransformHistoryCoordinator(historyRuntime() as never, controller);

    expect(() => history.begin('Move')).toThrow('scene projection failed');
    expect(useProjectStore.getState().projectMutationPendingCount).toBe(0);
  });

  it('releases the project fence when starting the Worker transaction throws synchronously', async () => {
    const onError = vi.fn();
    const runtime = {
      setModelTransforms: vi.fn(async () => ({ ok: true })),
      getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false, error: 'unused' })),
      getHistoryStatus: vi.fn(async () => ({ dirty: false, revision: 1 } as never)),
      ...emptyProjection,
      runProjectHistoryTransaction: vi.fn(() => { throw new Error('history unavailable'); }),
    };
    const volume = makeVolume(0, 0, 0);
    glVolumeCollection.replace([volume]);
    const history = new TransformHistoryCoordinator(runtime as never, new SceneInteractionController(() => [volume]), onError);

    history.begin('Move');
    await history.commit();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'history unavailable' }));
    expect(useProjectStore.getState().projectMutationPendingCount).toBe(0);
  });
});
