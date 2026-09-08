import * as THREE from 'three';
import type { ModelObjectBuffer } from '@slicer/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneInteractionController } from '../viewport/SceneInteractionController';
import { GLVolume, glVolumeCollection } from '../viewport/GLVolume';
import { TransformHistoryCoordinator } from './transformHistory';
import { useObjectListStore } from '../objectList/useObjectListStore';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';

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

function historyRuntime() {
  return {
    setModelTransform: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
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
  });

  it('opens one Worker transaction and waits for the final commit gate', async () => {
    let releaseMutation!: () => void;
    const mutationRelease = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const runtime = {
      setModelTransform: vi.fn(async () => ({ ok: true })),
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
    const controller = new SceneInteractionController(() => []);
    const history = new TransformHistoryCoordinator(runtime as never, controller);
    history.begin('Move');
    expect(runtime.runProjectHistoryTransaction).toHaveBeenCalledTimes(1);
    expect(runtime.setModelTransform).not.toHaveBeenCalled();
    const commit = history.commit();
    await Promise.resolve();
    releaseMutation();
    await commit;
    expect(runtime.setModelTransform).not.toHaveBeenCalled();
  });

  it('aborts a cancelled transaction without writing transforms', async () => {
    const runtime = {
      setModelTransform: vi.fn(async () => ({ ok: true })),
      runProjectHistoryTransaction: vi.fn(async (
        _label: string,
        _category: 'project' | 'context',
        _before: unknown,
        mutation: (tx: string) => Promise<unknown>,
        _after: unknown | (() => unknown),
      ) => ({ result: await mutation('tx-1'), status: {} as never })),
    };
    const controller = new SceneInteractionController(() => []);
    const history = new TransformHistoryCoordinator(runtime as never, controller);
    history.begin('Rotate');
    await history.abort();
    expect(runtime.setModelTransform).not.toHaveBeenCalled();
  });

  it('serializes rapid discrete commands until each Worker transaction settles', async () => {
    const started: string[] = [];
    const runtime = {
      setModelTransform: vi.fn(async () => ({ ok: true })),
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
    const controller = new SceneInteractionController(() => []);
    const history = new TransformHistoryCoordinator(runtime as never, controller);

    history.begin('Move');
    const firstCommit = history.commit();
    history.begin('Rotate');
    const secondCommit = history.commit();

    // The second command is accepted, but beginHistory must wait until the
    // first transaction has fully settled instead of overlapping it.
    expect(started).toEqual(['Move']);
    await firstCommit;
    await secondCommit;
    expect(started).toEqual(['Move', 'Rotate']);
  });

  it('writes one final stable transform per rendered CompositeID, only on commit', async () => {
    const volumes = [makeVolume(0, 0, 0), makeVolume(0, 1, 0)];
    glVolumeCollection.replace(volumes);
    const runtime = historyRuntime();
    const controller = new SceneInteractionController(() => volumes);
    const history = new TransformHistoryCoordinator(runtime as never, controller);
    controller.setTransformHistoryPort(history);
    controller.selectFromHit(volumes[0], false);

    expect(controller.tryBeginBodyDrag()).toBe(true);
    controller.updateDragPivot(new THREE.Vector3(2, 0, 0));
    controller.updateDragPivot(new THREE.Vector3(5, 0, 0));
    expect(runtime.setModelTransform).not.toHaveBeenCalled();

    expect(controller.endDrag()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.setModelTransform).toHaveBeenCalledTimes(volumes.length);
    expect(runtime.setModelTransform.mock.calls.map(([objectIdx, volumeIdx, instanceIdx]) => [objectIdx, volumeIdx, instanceIdx]))
      .toEqual([[0, 0, 0], [0, 1, 0]]);
    for (const [index, volume] of volumes.entries()) {
      const call = runtime.setModelTransform.mock.calls[index];
      expect(call[3]).toEqual(volume.instanceTransform);
      expect(call[4]).toEqual(volume.volumeTransform);
    }
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
    expect(runtime.setModelTransform).not.toHaveBeenCalled();
  });
});
