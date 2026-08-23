import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlicerRuntime } from '@orca/platform-contract';
import { useObjectListStore } from './useObjectListStore';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import {
  assembleObjectsInList,
  cloneObjectsInList,
  deleteObjectsInList,
  deleteVolumeInList,
  reorderObjectsInList,
  reorderVolumesInList,
} from './structuralActions';

const structure = {
  ok: true as const,
  objects: [{ id: 1, index: 0, name: 'A', printable: true, instanceCount: 1, volumes: [], instances: [] }],
};

function makeRuntime(): SlicerRuntime {
  return {
    deleteObjects: vi.fn(async () => ({ ok: true, objects: 0, deleted: 1 })),
    deleteVolumes: vi.fn(async () => ({ ok: true, deleted: 1 })),
    cloneObjects: vi.fn(async () => ({ ok: true, newObjectIds: [2] })),
    mergeObjectsToMultipart: vi.fn(async () => ({ ok: true, objectId: 9 })),
    reorderObjects: vi.fn(async () => ({ ok: true, objects: [] })),
    reorderVolumes: vi.fn(async () => ({ ok: true, objects: [] })),
    getModelStructure: vi.fn(async () => structure),
  } as unknown as SlicerRuntime;
}

describe('object list structural actions', () => {
  beforeEach(() => {
    useObjectListStore.setState({ structure: [], loaded: false, expanded: {}, projection: { objectIds: new Set(), volumeIds: new Set(), instanceIds: new Set() } });
    useSlicerStore.setState({ status: 'done', resultExported: true, error: 'stale', layers: 40 });
    useSettingsStore.setState({ modelLoaded: true, modelRevision: 3 });
  });

  it('deleteObjectsInList calls the bridge and refreshes geometry', async () => {
    const runtime = makeRuntime();
    const before = useSettingsStore.getState().modelRevision;
    const r = await deleteObjectsInList(runtime, [1]);
    expect(r).toEqual({ ok: true });
    expect(runtime.deleteObjects).toHaveBeenCalledWith([1]);
    expect(useSettingsStore.getState().modelRevision).toBe(before + 1);
    expect(useSlicerStore.getState().status).toBe('idle');
  });

  it('deleteVolumeInList calls deleteVolumes', async () => {
    const runtime = makeRuntime();
    await deleteVolumeInList(runtime, 10);
    expect(runtime.deleteVolumes).toHaveBeenCalledWith([10]);
  });

  it('cloneObjectsInList calls cloneObjects and refreshes', async () => {
    const runtime = makeRuntime();
    const r = await cloneObjectsInList(runtime, [1]);
    expect(r).toEqual({ ok: true });
    expect(runtime.cloneObjects).toHaveBeenCalledWith([1]);
    expect(useObjectListStore.getState().structure).toHaveLength(1);
  });

  it('assembleObjectsInList passes a name and refreshes', async () => {
    const runtime = makeRuntime();
    await assembleObjectsInList(runtime, [1, 2], 'Asm');
    expect(runtime.mergeObjectsToMultipart).toHaveBeenCalledWith([1, 2], 'Asm');
  });

  it('reorderObjectsInList calls the bridge with stable IDs', async () => {
    const runtime = makeRuntime();
    await reorderObjectsInList(runtime, 2, 1);
    expect(runtime.reorderObjects).toHaveBeenCalledWith(2, 1);
  });

  it('reorderVolumesInList calls the bridge with the object and volume IDs', async () => {
    const runtime = makeRuntime();
    await reorderVolumesInList(runtime, 5, 20, 10);
    expect(runtime.reorderVolumes).toHaveBeenCalledWith(5, 20, 10);
  });

  it('propagates a bridge error without refreshing', async () => {
    const runtime = makeRuntime();
    (runtime.deleteObjects as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: 'object not found' });
    const r = await deleteObjectsInList(runtime, [1]);
    expect(r).toEqual({ ok: false, error: 'object not found' });
    expect(useSlicerStore.getState().status).toBe('done');
  });
});
