import { describe, expect, it, vi } from 'vitest';
import type {
  ModelObjectBuffer,
  ModelObjectStructure,
  ModelScenePatchResult,
  SceneDelta,
} from '@slicer/client';
import { GLVolume, glVolumeCollection } from './GLVolume';
import { composeSceneDeltaProjection, readSceneDeltaProjection } from './sceneDeltaProjection';

function structure(objectId: number, index: number): ModelObjectStructure {
  return {
    id: objectId,
    index,
    name: `object-${objectId}`,
    printable: true,
    instanceCount: 1,
    volumes: [{ id: objectId + 100, index: 0, name: 'part', type: 'model_part', isSplittable: false }],
    instances: [{ id: objectId + 200, index: 0, printable: true }],
  };
}

function buffer(objectId: number, objectIdx: number, offset = 0): ModelObjectBuffer {
  return {
    objectId,
    volumeId: objectId + 100,
    instanceId: objectId + 200,
    objectIdx,
    volumeIdx: 0,
    instanceIdx: 0,
    positions: new Float32Array([offset, 0, 0, offset + 1, 0, 0, offset, 1, 0]),
    vertexCount: 3,
    indices: new Uint32Array([0, 1, 2]),
    indexCount: 3,
    offset: [0, 0, 0],
    instanceTransform: { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] },
    volumeTransform: { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] },
  };
}

function delta(
  objectOrder: readonly number[],
  plateIds: readonly string[],
): SceneDelta {
  return {
    version: 1,
    objectIds: [10, 20, 30],
    volumeIds: [110, 120, 130],
    instanceIds: [210, 220, 230],
    plateIds,
    objectOrder,
  };
}

function patch(objectOrder: number[], objectIds: number[], offset: number): ModelScenePatchResult {
  return {
    ok: true,
    objectOrder,
    objects: objectIds.map((id) => structure(id, objectOrder.indexOf(id))),
    meshes: objectIds.map((id) => buffer(id, objectOrder.indexOf(id), offset)),
  };
}

describe('SceneDelta projection', () => {
  it('uses the native unchanged-renderer proof without copying or rebuilding displayed meshes', async () => {
    const current = structure(10, 0);
    const volume = new GLVolume(buffer(10, 0));
    const getModelScenePatch = vi.fn(async () => patch([10], [], 0));
    const result = await readSceneDeltaProjection({ getModelScenePatch }, {
      ...delta([10], ['plate-a']), objectIds: [10], retainedRendererObjectIds: [10],
      retainedVolumeTransforms: [{ volumeId: 110, transform: { ...volume.volumeTransform, offset: [2, 3, 4] } }],
    }, [current], [volume]);
    expect(getModelScenePatch).toHaveBeenCalledWith([]);
    expect(result.structure[0]).toBe(current);
    expect(result.volumes[0]).toBe(volume);
    expect(result.volumes[0].geometry).toBe(volume.geometry);
    expect(result.volumes[0].volumeTransform.offset).toEqual([2, 3, 4]);
    volume.dispose();
  });
  it('publishes one collection update while retaining an unchanged GLVolume and geometry', () => {
    const retained = new GLVolume(buffer(40, 0));
    const replacement = new GLVolume(buffer(10, 1, 10));
    const retainedGeometry = retained.geometry;
    glVolumeCollection.replace([retained], 10);
    let publications = 0;
    const unsubscribe = glVolumeCollection.subscribe(() => { publications += 1; });

    glVolumeCollection.patch([retained, replacement], 11);

    expect(publications).toBe(1);
    expect(glVolumeCollection.volumes[0]).toBe(retained);
    expect(glVolumeCollection.volumes[0].geometry).toBe(retainedGeometry);
    expect(glVolumeCollection.revision).toBe(11);
    unsubscribe();
    glVolumeCollection.clear(12);
  });

  it('applies a multi-object direct jump, undo, and redo while preserving every untouched mesh', () => {
    const initialStructure = [structure(10, 0), structure(20, 1), structure(40, 2)];
    const initialVolumes = initialStructure.map((object) => new GLVolume(buffer(object.id, object.index)));
    const unchanged = initialVolumes[2];
    const unchangedGeometry = unchanged.geometry;

    const jumpDelta = delta([40, 10, 30], ['plate-a', 'plate-b']);
    expect(jumpDelta).toEqual({
      version: 1,
      objectIds: [10, 20, 30],
      volumeIds: [110, 120, 130],
      instanceIds: [210, 220, 230],
      plateIds: ['plate-a', 'plate-b'],
      objectOrder: [40, 10, 30],
    });
    const jumped = composeSceneDeltaProjection(
      jumpDelta, patch([40, 10, 30], [10, 30], 10), initialStructure, initialVolumes,
    );
    expect(jumped.structure.map((object) => object.id)).toEqual([40, 10, 30]);
    expect(jumped.volumes.map((volume) => volume.buffer.objectId)).toEqual([40, 10, 30]);
    expect(jumped.volumes[0]).toBe(unchanged);
    expect(jumped.volumes[0].geometry).toBe(unchangedGeometry);
    expect(jumped.volumes[1]).not.toBe(initialVolumes[0]);

    const undoDelta = delta([10, 20, 40], ['plate-a', 'plate-b']);
    const undone = composeSceneDeltaProjection(
      undoDelta, patch([10, 20, 40], [10, 20], 20), jumped.structure, jumped.volumes,
    );
    expect(undone.volumes.map((volume) => volume.buffer.objectId)).toEqual([10, 20, 40]);
    expect(undone.volumes[2]).toBe(unchanged);
    expect(undone.volumes[2].geometry).toBe(unchangedGeometry);

    const redone = composeSceneDeltaProjection(
      jumpDelta, patch([40, 10, 30], [10, 30], 30), undone.structure, undone.volumes,
    );
    expect(redone.volumes.map((volume) => volume.buffer.objectId)).toEqual([40, 10, 30]);
    expect(redone.volumes[0]).toBe(unchanged);
    expect(redone.volumes[0].geometry).toBe(unchangedGeometry);

    const allVolumes = new Set([...initialVolumes, ...jumped.volumes, ...undone.volumes, ...redone.volumes]);
    for (const volume of allVolumes) volume.dispose();
  });

  it('does not mutate retained mesh indexes when a patch fails validation', () => {
    const currentStructure = [structure(10, 0), structure(40, 1)];
    const currentVolumes = currentStructure.map((object) => new GLVolume(buffer(object.id, object.index)));
    const retained = currentVolumes[1];

    expect(() => composeSceneDeltaProjection(
      { ...delta([40, 10, 30], ['plate-a']), objectIds: [10, 30] },
      { ...patch([40, 10, 30], [10], 10), objects: [structure(10, 1)] },
      currentStructure,
      currentVolumes,
    )).toThrow('model scene patch structure does not match touched object ids');
    expect(retained.buffer.objectIdx).toBe(1);
    expect(retained.geometry).toBe(currentVolumes[1].geometry);

    for (const volume of currentVolumes) volume.dispose();
  });
});
