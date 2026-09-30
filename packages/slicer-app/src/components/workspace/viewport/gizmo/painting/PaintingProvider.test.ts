import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelObjectBuffer, ModelObjectStructure, ModelScenePatchResult } from '@slicer/client';
import { preparePaintingClosedScene } from './PaintingProvider';
import { glVolumeCollection, retainedPaintGeometry } from '@/components/workspace/viewport/GLVolume';
import { projectFullModelMesh } from '@/components/workspace/viewport/modelMeshProjection';
import { useObjectListStore } from '@/components/workspace/objectList/useObjectListStore';
import { useSettingsStore } from '@/stores/useSettingsStore';

const transform = { offset: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], mirror: [1, 1, 1] as [number, number, number] };
const structure = (id: number, index: number): ModelObjectStructure => ({ id, index, name: `object-${id}`, printable: true, instanceCount: 1,
  volumes: [{ id: id + 10, index: 0, name: 'part', type: 'model_part', isSplittable: false }],
  instances: [{ id: id + 20, index: 0, printable: true }] });
const buffer = (id: number, index: number): ModelObjectBuffer => ({ objectId: id, volumeId: id + 10, instanceId: id + 20,
  objectIdx: index, volumeIdx: 0, instanceIdx: 0, offset: [0, 0, 0], instanceTransform: transform, volumeTransform: transform,
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]), vertexCount: 3, indexCount: 3 });
function fixture() {
  const volumes = projectFullModelMesh({ ok: true, paintGeometries: [], objects: [1, 2].map((id, index) => ({ ...buffer(id, index), geometryKey: `source-${id}`, paintGeometryKey: null })) });
  useObjectListStore.getState().setStructure([structure(1, 0), structure(2, 1)]);
  glVolumeCollection.replace(volumes, useSettingsStore.getState().modelRevision);
  const patch: ModelScenePatchResult = { ok: true, objectOrder: [1, 2], objects: [structure(1, 0)],
    meshes: [{ ...buffer(1, 0), geometryKey: 'source-1', paintGeometryKey: 'paint-1' }], geometries: [],
    paintGeometries: [{ ...buffer(1, 0), paintGeometryKey: 'paint-1', drawGroups: [{ stateId: 2, startIndex: 0, indexCount: 3 }] }] };
  const getModelScenePatch = vi.fn(async () => patch);
  return { volumes, patch, runtime: { getModelScenePatch, getModelMesh: vi.fn() } };
}
afterEach(() => { glVolumeCollection.clear(); useObjectListStore.getState().setStructure([]); });
describe('painting closure Prepare publication', () => {
  it('retains the complete no-op scene without native geometry reads or publication', async () => {
    const { runtime, volumes } = fixture(); const publish = vi.spyOn(glVolumeCollection, 'publish');
    await preparePaintingClosedScene(runtime, []);
    expect(runtime.getModelScenePatch).not.toHaveBeenCalled(); expect(runtime.getModelMesh).not.toHaveBeenCalled();
    expect(glVolumeCollection.volumes).toBe(volumes); expect(publish).not.toHaveBeenCalled(); publish.mockRestore();
  });
  it('exports only paint for touched objects and preserves unrelated wrappers and original BVH', async () => {
    const { runtime, volumes } = fixture(), original = volumes[0]!.geometry;
    await preparePaintingClosedScene(runtime, [1]);
    expect(runtime.getModelScenePatch).toHaveBeenCalledExactlyOnceWith([1], ['source-1'], []);
    expect(runtime.getModelMesh).not.toHaveBeenCalled();
    expect(glVolumeCollection.volumes[1]).toBe(volumes[1]);
    expect(glVolumeCollection.volumes[0]!.geometry).toBe(original);
    expect(glVolumeCollection.volumes[0]!.paintGeometryKey).toBe('paint-1');
    expect(glVolumeCollection.volumes[0]!.paintGeometry).toBeDefined();
  });
  it('keeps the old scene intact after missing paint, then retries with complete resources', async () => {
    const { runtime, patch, volumes } = fixture(); const validPaint = patch.paintGeometries;
    patch.paintGeometries = [];
    await expect(preparePaintingClosedScene(runtime, [1])).rejects.toThrow('missing model paint geometry');
    expect(glVolumeCollection.volumes).toBe(volumes); expect(retainedPaintGeometry('paint-1')).toBeUndefined();
    patch.paintGeometries = validPaint; await preparePaintingClosedScene(runtime, [1]);
    expect(glVolumeCollection.volumes[0]!.paintGeometryKey).toBe('paint-1');
    expect(glVolumeCollection.volumes[1]).toBe(volumes[1]);
  });
  it('releases earlier staged paint resources when a later touched volume fails validation', async () => {
    const { runtime, patch, volumes } = fixture();
    patch.objects.push(structure(2, 1));
    patch.meshes.push({ ...buffer(2, 1), geometryKey: 'source-2', paintGeometryKey: 'missing-paint-2' });
    await expect(preparePaintingClosedScene(runtime, [1, 2])).rejects.toThrow('missing model paint geometry missing-paint-2');
    expect(glVolumeCollection.volumes).toBe(volumes);
    expect(retainedPaintGeometry('paint-1')).toBeUndefined();
    expect(volumes[0]!.geometry.getAttribute('position').count).toBe(3);
  });
  it('retains current geometry after a previously painted object was deleted by a project command', async () => {
    const { runtime, patch, volumes } = fixture();
    useObjectListStore.getState().setStructure([structure(2, 0)]);
    glVolumeCollection.patch([volumes[1]!], useSettingsStore.getState().modelRevision);
    Object.assign(patch, { objectOrder: [2], objects: [], meshes: [], geometries: [], paintGeometries: [] });
    await preparePaintingClosedScene(runtime, [1]);
    expect(runtime.getModelScenePatch).toHaveBeenCalledExactlyOnceWith([1], [], []);
    expect(glVolumeCollection.volumes).toEqual([volumes[1]]);
    expect(glVolumeCollection.volumes[0]).toBe(volumes[1]);
  });
});
