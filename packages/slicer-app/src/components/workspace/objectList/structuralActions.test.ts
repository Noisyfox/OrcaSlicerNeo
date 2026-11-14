import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlicerRuntime } from '@orca/platform-contract';
import { useObjectListStore } from './useObjectListStore';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { waitForSettledModelTransforms } from '../actions/persistModelTransforms';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import {
  addInstanceInList,
  assembleObjectsInList,
  cloneObjectsInList,
  deleteObjectsInList,
  deleteVolumeInList,
  removeInstanceInList,
  reorderObjectsInList,
  reorderVolumesInList,
  separateInstancesInList,
  splitObjectToObjectsInList,
  splitVolumeToPartsInList,
} from './structuralActions';

vi.mock('../actions/persistModelTransforms', () => ({
  waitForSettledModelTransforms: vi.fn(async () => ({ ok: true })),
}));

const structure = {
  ok: true as const,
  objects: [{ id: 1, index: 0, name: 'A', printable: true, instanceCount: 1, volumes: [], instances: [] }],
};

function makeRuntime(): SlicerRuntime {
  return {
    deleteObjects: vi.fn(async () => ({ ok: true, objects: 0, deleted: 1 })),
    deleteVolumes: vi.fn(async () => ({ ok: true, deleted: 1 })),
    cloneObjects: vi.fn(async () => ({ ok: true, newObjectIds: [2] })),
    splitVolumeToParts: vi.fn(async () => ({ ok: true })),
    splitObjectToObjects: vi.fn(async () => ({ ok: true })),
    mergeObjectsToMultipart: vi.fn(async () => ({ ok: true, objectId: 9 })),
    reorderObjects: vi.fn(async () => ({ ok: true, objects: [] })),
    reorderVolumes: vi.fn(async () => ({ ok: true, objects: [] })),
    separateInstances: vi.fn(async () => ({ ok: true, newObjectIds: [21] })),
    addInstance: vi.fn(async () => ({ ok: true, objectId: 1, instanceId: 22 })),
    removeInstance: vi.fn(async () => ({ ok: true })),
    getModelScenePatch: vi.fn(async () => ({ ok: true, objectOrder: [1], objects: structure.objects, meshes: [], geometries: [], paintGeometries: [] })),
    getModelStructure: vi.fn(async () => structure),
    getHistoryStatus: vi.fn(async () => ({ dirty: false } as never)),
    getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false, error: 'unused' } as never)),
    runProjectHistoryTransaction: vi.fn(async <T>(
      _label: string,
      _category: 'project',
      _before: unknown,
      mutation: (transactionId: string) => Promise<T>,
      _after: unknown | (() => unknown | Promise<unknown>),
    ) => ({ sceneDelta: { version: 1, objectIds: [1], volumeIds: [], instanceIds: [], plateIds: [], objectOrder: [1] }, result: await mutation('tx-1'), status: {} as never })),
  } as unknown as SlicerRuntime;
}

describe('object list structural actions', () => {
  beforeEach(() => {
    vi.mocked(waitForSettledModelTransforms).mockReset();
    vi.mocked(waitForSettledModelTransforms).mockResolvedValue({ ok: true });
    useObjectListStore.setState({ structure: [], loaded: false, expanded: {}, projection: { objectIds: new Set(), volumeIds: new Set(), instanceIds: new Set() } });
    useSlicerStore.setState({ status: 'done', resultExported: true, error: 'stale', maxLayer: 39 });
    useSettingsStore.setState({ modelLoaded: true, modelRevision: 3 });
  });

  it.each([
    ['part', (runtime: SlicerRuntime) => splitVolumeToPartsInList(runtime, 10, null), 'splitVolumeToParts', [10]],
    ['object', (runtime: SlicerRuntime) => splitObjectToObjectsInList(runtime, 1, null), 'splitObjectToObjects', [1]],
  ] as const)('splits the selected %s', async (_name, operation, method, args) => {
    const runtime = makeRuntime();
    expect(await operation(runtime)).toEqual({ ok: true });
    expect(runtime[method]).toHaveBeenCalledWith(...args);
  });

  it('deleteObjectsInList calls the bridge and refreshes geometry', async () => {
    const runtime = makeRuntime();
    const before = useSettingsStore.getState().modelRevision;
    const r = await deleteObjectsInList(runtime, [1], null);
    expect(r).toEqual({ ok: true });
    expect(runtime.deleteObjects).toHaveBeenCalledWith([1]);
    expect(useSettingsStore.getState().modelRevision).toBe(before);
    expect(useSlicerStore.getState().status).toBe('idle');
  });

  it('captures the current scene selection and gizmo in structural history', async () => {
    const runtime = makeRuntime();
    useObjectListStore.getState().setStructure([{ id: 1, index: 0, name: 'A', printable: true, instanceCount: 1,
      volumes: [{ id: 10, index: 0, name: 'Part', type: 'model_part', isSplittable: false }],
      instances: [{ id: 20, index: 0, printable: true }] }]);
    const scene = { gizmo: 'move', selectionMode: 'instance', selectedVolumes: () => [{ buffer: {
      objectId: 1, objectIdx: 0, volumeId: 10, volumeIdx: 0, instanceId: 20, instanceIdx: 0,
    } }] } as unknown as SceneInteractionController;
    await deleteObjectsInList(runtime, [1], scene);
    expect(vi.mocked(runtime.runProjectHistoryTransaction).mock.calls[0][2]).toMatchObject({
      gizmo: { type: 'move' }, selection: { objectIds: [1] },
    });
  });

  it('deleteVolumeInList calls deleteVolumes', async () => {
    const runtime = makeRuntime();
    await deleteVolumeInList(runtime, 10, null);
    expect(runtime.deleteVolumes).toHaveBeenCalledWith([10]);
  });

  it('cloneObjectsInList calls cloneObjects and refreshes', async () => {
    const runtime = makeRuntime();
    const r = await cloneObjectsInList(runtime, [1], null);
    expect(r).toEqual({ ok: true });
    expect(runtime.cloneObjects).toHaveBeenCalledWith([1]);
    expect(useObjectListStore.getState().structure).toHaveLength(1);
  });

  it('assembleObjectsInList passes a name and refreshes', async () => {
    const runtime = makeRuntime();
    await assembleObjectsInList(runtime, [1, 2], null, 'Asm');
    expect(runtime.mergeObjectsToMultipart).toHaveBeenCalledWith([1, 2], 'Asm');
  });

  it('reorderObjectsInList calls the bridge with the source object ID and a destination index', async () => {
    const runtime = makeRuntime();
    await reorderObjectsInList(runtime, 2, 1, null);
    expect(runtime.reorderObjects).toHaveBeenCalledWith(2, 1);
  });

  it('waits for pending transforms before reordering model indices', async () => {
    let release!: (result: { ok: boolean }) => void;
    vi.mocked(waitForSettledModelTransforms).mockReturnValueOnce(new Promise((resolve) => {
      release = resolve;
    }));
    const runtime = makeRuntime();
    const mutation = reorderObjectsInList(runtime, 2, 1, null);

    await Promise.resolve();
    expect(runtime.reorderObjects).not.toHaveBeenCalled();

    release({ ok: true });
    await mutation;
    expect(runtime.reorderObjects).toHaveBeenCalledWith(2, 1);
  });

  it('reorderVolumesInList calls the bridge with the object/volume IDs and a destination index', async () => {
    const runtime = makeRuntime();
    await reorderVolumesInList(runtime, 5, 20, 10, null);
    expect(runtime.reorderVolumes).toHaveBeenCalledWith(5, 20, 10);
  });

  it('separateInstancesInList promotes the selected instances into objects', async () => {
    const runtime = makeRuntime();
    await separateInstancesInList(runtime, 1, [20], null);
    expect(runtime.separateInstances).toHaveBeenCalledWith(1, [20]);
  });

  it('addInstanceInList adds an instance and refreshes', async () => {
    const runtime = makeRuntime();
    await addInstanceInList(runtime, 1, null);
    expect(runtime.addInstance).toHaveBeenCalledWith(1);
  });

  it('removeInstanceInList removes the instance and refreshes', async () => {
    const runtime = makeRuntime();
    await removeInstanceInList(runtime, 1, 22, null);
    expect(runtime.removeInstance).toHaveBeenCalledWith(1, 22);
  });

  it('propagates a bridge error without refreshing', async () => {
    const runtime = makeRuntime();
    (runtime.deleteObjects as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: 'object not found' });
    const r = await deleteObjectsInList(runtime, [1], null);
    expect(r).toEqual({ ok: false, error: 'object not found' });
    expect(useSlicerStore.getState().status).toBe('done');
  });

  it('aborts structural mutations when pending transform persistence fails', async () => {
    vi.mocked(waitForSettledModelTransforms).mockResolvedValueOnce({
      ok: false,
      error: 'transform sync failed',
    });
    const runtime = makeRuntime();
    const r = await deleteObjectsInList(runtime, [1], null);

    expect(r).toEqual({ ok: false, error: 'transform sync failed' });
    expect(runtime.deleteObjects).not.toHaveBeenCalled();
    expect(useSlicerStore.getState().status).toBe('done');
  });
});
