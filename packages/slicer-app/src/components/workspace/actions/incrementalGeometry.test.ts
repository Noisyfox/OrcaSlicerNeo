import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, createMockModule } from '../../../../../slicer-wasm/src/client/index';
import { runProjectHistoryMutation } from './historyMutation';
import { useObjectListStore } from '../objectList/useObjectListStore';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { GLVolume, glVolumeCollection, leaseGeometry, retainedGeometry } from '../viewport/GLVolume';
import { readSceneDeltaProjection } from '../viewport/sceneDeltaProjection';

describe('committed incremental geometry', () => {
  beforeEach(() => {
    glVolumeCollection.clear(0);
    useObjectListStore.getState().clear();
    useSettingsStore.setState({ modelLoaded: false, modelRevision: 0 });
  });
  afterEach(() => glVolumeCollection.clear(0));

  it('reuses native volume geometry across add, instance, rename, clone and Undo/Redo without a full read', async () => {
    const runtime = createClient(async () => createMockModule());
    await runtime.init();
    const full = vi.spyOn(runtime, 'getModelMesh');
    const patch = vi.spyOn(runtime, 'getModelScenePatch');
    const edit = (label: string, mutation: () => Promise<{ ok: boolean }>) =>
      runProjectHistoryMutation(runtime, label, mutation);
    await edit('Add Cube', () => runtime.addShape('Cube'));
    const first = glVolumeCollection.volumes[0];
    const geometry = first.geometry;
    const id = first.buffer.objectId;
    await edit('Add Cube', () => runtime.addShape('Cube'));
    expect(glVolumeCollection.volumes[0]).toBe(first);
    expect(patch.mock.calls[1][0]).toEqual([glVolumeCollection.volumes[1].buffer.objectId]);
    await edit('Add instance', () => runtime.addInstance(id));
    const instances = glVolumeCollection.volumes.filter((volume) => volume.buffer.objectId === id);
    expect(instances).toHaveLength(2);
    expect(instances.every((volume) => volume.geometry === geometry)).toBe(true);
    expect((await patch.mock.results[2].value).geometries).toHaveLength(0);
    await edit('Rename', () => runtime.renameObject(id, 'Renamed'));
    expect((await patch.mock.results[3].value).geometries).toHaveLength(0);
    await edit('Clone', () => runtime.cloneObjects([id]));
    expect((await patch.mock.results[4].value).geometries).toHaveLength(1);
    const clone = glVolumeCollection.volumes.at(-1)!;
    expect(clone.buffer.volumeId).not.toBe(first.buffer.volumeId);
    expect(clone.geometry).not.toBe(geometry);

    for (const restore of [() => runtime.undoHistory(), () => runtime.redoHistory()]) {
      const result = await restore();
      if (!result.ok || !result.sceneDelta) throw new Error('missing restore delta');
      const projection = await readSceneDeltaProjection(runtime, result.sceneDelta,
        useObjectListStore.getState().structure, glVolumeCollection.volumes);
      projection.apply();
      useObjectListStore.getState().setStructure(projection.structure);
      glVolumeCollection.patch(projection.volumes, 0);
      expect(glVolumeCollection.volumes.find((volume) => volume.buffer.objectId === id)?.geometry).toBe(geometry);
    }
    expect(full).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().modelRevision).toBe(0);
  });

  it('pins advertised resources until asynchronous reads finish and disposes the last owner once', async () => {
    const runtime = createClient(async () => createMockModule());
    await runtime.init();
    await runProjectHistoryMutation(runtime, 'Cube', () => runtime.addShape('Cube'));
    const volume = glVolumeCollection.volumes[0];
    if (volume.ownership.kind !== 'shared') throw new Error('expected shared geometry');
    const key = volume.ownership.key;
    const dispose = vi.spyOn(volume.geometry, 'dispose');
    const release = leaseGeometry([key]);
    glVolumeCollection.clear(0);
    expect(dispose).not.toHaveBeenCalled();
    const retained = retainedGeometry(key)!;
    const second = new GLVolume({ ...volume.buffer, ...retained }, { kind: 'shared', key });
    release();
    second.dispose();
    second.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(retainedGeometry(key)).toBeUndefined();
  });

  it('rejects a stale projection without mutating retained transforms or indices', async () => {
    const runtime = createClient(async () => createMockModule());
    await runtime.init();
    await runProjectHistoryMutation(runtime, 'Cube', () => runtime.addShape('Cube'));
    const original = glVolumeCollection.volumes[0];
    const read = runtime.getModelScenePatch.bind(runtime);
    vi.spyOn(runtime, 'getModelScenePatch').mockImplementation(async (...args) => {
      const result = await read(...args);
      useSettingsStore.setState({ modelRevision: 2 });
      return result;
    });
    await expect(runProjectHistoryMutation(runtime, 'Add', () => runtime.addShape('Cube')))
      .rejects.toThrow('superseded');
    expect(glVolumeCollection.volumes).toEqual([original]);
    expect(original.buffer.objectIdx).toBe(0);
  });
});
