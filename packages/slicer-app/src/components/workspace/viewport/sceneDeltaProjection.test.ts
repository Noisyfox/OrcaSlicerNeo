import { describe, expect, it, vi } from 'vitest';
import type {
  ModelObjectBuffer,
  ModelObjectStructure,
  ModelPaintGeometry,
  ModelScenePatchResult,
  SceneDelta,
} from '@slicer/client';
import { GLVolume, glVolumeCollection, retainedPaintGeometry } from './GLVolume';
import { composeSceneDeltaProjection, readSceneDeltaProjection } from './sceneDeltaProjection';
import { projectFullModelMesh } from './modelMeshProjection';

function structure(objectId: number, index: number, volumeId = objectId + 100): ModelObjectStructure {
  return {
    id: objectId,
    index,
    name: `object-${objectId}`,
    printable: true,
    instanceCount: 1,
    volumes: [{ id: volumeId, index: 0, name: 'part', type: 'model_part', isSplittable: false }],
    instances: [{ id: objectId + 200, index: 0, printable: true }],
  };
}

function buffer(objectId: number, objectIdx: number, offset = 0, volumeId = objectId + 100): ModelObjectBuffer {
  return {
    objectId,
    volumeId,
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
    meshes: objectIds.map((id) => ({ ...buffer(id, objectOrder.indexOf(id), offset), geometryKey: `test:${id + 100}`, paintGeometryKey: null })),
    geometries: objectIds.map((id) => ({ ...buffer(id, objectOrder.indexOf(id), offset), geometryKey: `test:${id + 100}` })),
    paintGeometries: [],
  };
}

function paintGeometry(paintGeometryKey: string, volumeId = 110, offset = 0): ModelPaintGeometry {
  return {
    paintGeometryKey,
    volumeId,
    positions: new Float32Array([offset, 0, 0, offset + 1, 0, 0, offset, 1, 0]),
    vertexCount: 3,
    indices: new Uint32Array([0, 1, 2]),
    indexCount: 3,
    drawGroups: [{ stateId: 2, startIndex: 0, indexCount: 3 }],
  };
}

function paintedFullResult(paintKey: string, paint = paintGeometry(paintKey)) {
  return {
    ok: true,
    objects: [{ ...buffer(10, 0), geometryKey: 'original:110', paintGeometryKey: paintKey }],
    paintGeometries: [paint],
  };
}

function paintedPatch(
  originalKey: string,
  paintKey: string,
  geometries: ModelScenePatchResult['geometries'] = [],
  paintGeometries: ModelPaintGeometry[] = [],
  offset = 0,
  volumeId = 110,
): ModelScenePatchResult {
  return {
    ok: true,
    objectOrder: [10],
    objects: [structure(10, 0, volumeId)],
    meshes: [{ ...buffer(10, 0, offset, volumeId), geometryKey: originalKey, paintGeometryKey: paintKey }],
    geometries,
    paintGeometries,
  };
}

describe('SceneDelta projection', () => {
  it('uses the native unchanged-renderer proof without copying or rebuilding displayed meshes', async () => {
    const current = structure(10, 0);
    const volume = new GLVolume(buffer(10, 0), { kind: 'exclusive' });
    const getModelScenePatch = vi.fn(async () => patch([10], [], 0));
    const result = await readSceneDeltaProjection({ getModelScenePatch }, {
      ...delta([10], ['plate-a']), objectIds: [10], retainedRendererObjectIds: [10],
      retainedVolumeTransforms: [{ volumeId: 110, transform: { ...volume.volumeTransform, offset: [2, 3, 4] } }],
    }, [current], [volume]);
    expect(getModelScenePatch).toHaveBeenCalledWith([], [], []);
    result.apply();
    expect(result.structure[0]).toBe(current);
    expect(result.volumes[0]).toBe(volume);
    expect(result.volumes[0].geometry).toBe(volume.geometry);
    expect(result.volumes[0].volumeTransform.offset).toEqual([2, 3, 4]);
    volume.dispose();
  });
  it('publishes one collection update while retaining an unchanged GLVolume and geometry', () => {
    const retained = new GLVolume(buffer(40, 0), { kind: 'exclusive' });
    const replacement = new GLVolume(buffer(10, 1, 10), { kind: 'exclusive' });
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
    const initialVolumes = initialStructure.map((object) => new GLVolume(buffer(object.id, object.index), { kind: 'exclusive' }));
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
    const currentVolumes = currentStructure.map((object) => new GLVolume(buffer(object.id, object.index), { kind: 'exclusive' }));
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

  it('resolves original and paint cache hits independently', async () => {
    const [current] = projectFullModelMesh(paintedFullResult('paint:110:v1'));
    const originalGeometry = current.geometry;
    const paintDisplayGeometry = current.paintGeometry;
    const getModelScenePatch = vi.fn(async () => paintedPatch('original:110', 'paint:110:v1'));
    const result = await readSceneDeltaProjection({ getModelScenePatch }, {
      ...delta([10], ['plate-a']), objectIds: [10], volumeIds: [110], instanceIds: [210],
    }, [structure(10, 0)], [current]);

    expect(getModelScenePatch).toHaveBeenCalledWith([10], ['original:110'], ['paint:110:v1']);
    expect(result.volumes[0].geometry).toBe(originalGeometry);
    expect(result.volumes[0].paintGeometry).toBe(paintDisplayGeometry);
    result.volumes.forEach((volume) => volume.dispose());
    current.dispose();
  });

  it('replaces paint on a paint-only patch while retaining the original geometry and BVH', async () => {
    const [current] = projectFullModelMesh(paintedFullResult('paint:110:v1'));
    const originalGeometry = current.geometry;
    const originalBoundsTree = (originalGeometry as typeof originalGeometry & { boundsTree?: unknown }).boundsTree;
    const oldPaintGeometry = current.paintGeometry!;
    const disposeOldPaint = vi.spyOn(oldPaintGeometry, 'dispose');
    const getModelScenePatch = vi.fn(async () => paintedPatch(
      'original:110', 'paint:110:v2', [], [paintGeometry('paint:110:v2', 110, 2)],
    ));

    const result = await readSceneDeltaProjection({ getModelScenePatch }, {
      ...delta([10], ['plate-a']), objectIds: [10], volumeIds: [110], instanceIds: [210],
    }, [structure(10, 0)], [current]);
    const replacement = result.volumes[0];
    expect(replacement.geometry).toBe(originalGeometry);
    expect((replacement.geometry as typeof originalGeometry & { boundsTree?: unknown }).boundsTree).toBe(originalBoundsTree);
    expect(replacement.paintGeometry).not.toBe(oldPaintGeometry);
    expect(replacement.paintGeometry?.groups).toEqual([{ start: 0, count: 3, materialIndex: 0 }]);
    expect(getModelScenePatch).toHaveBeenCalledWith([10], ['original:110'], ['paint:110:v1']);

    current.dispose();
    expect(disposeOldPaint).toHaveBeenCalledOnce();
    expect(retainedPaintGeometry('paint:110:v1')).toBeUndefined();
    replacement.dispose();
  });

  it('loads a missed original resource while reusing a retained paint resource', async () => {
    const existingPaint = paintGeometry('paint:110:v1');
    const current = new GLVolume(buffer(10, 0), { kind: 'exclusive' },
      { key: 'paint:110:v1', buffer: existingPaint });
    const oldOriginalGeometry = current.geometry;
    const getModelScenePatch = vi.fn(async () => paintedPatch(
      'original:110', 'paint:110:v1', [
        { geometryKey: 'original:110', volumeId: 110, positions: buffer(10, 0).positions,
          indices: buffer(10, 0).indices, vertexCount: 3, indexCount: 3 },
      ],
    ));

    const result = await readSceneDeltaProjection({ getModelScenePatch }, {
      ...delta([10], ['plate-a']), objectIds: [10], volumeIds: [110], instanceIds: [210],
    }, [structure(10, 0)], [current]);
    expect(getModelScenePatch).toHaveBeenCalledWith([10], [], ['paint:110:v1']);
    expect(result.volumes[0].geometry).not.toBe(oldOriginalGeometry);
    expect(result.volumes[0].paintGeometry).toBe(current.paintGeometry);
    result.volumes.forEach((volume) => volume.dispose());
    current.dispose();
  });

  it('leases original and paint geometry independently across an asynchronous patch read', async () => {
    const [current] = projectFullModelMesh(paintedFullResult('paint:110:v1'));
    const originalGeometry = current.geometry;
    const paintDisplayGeometry = current.paintGeometry!;
    const disposeOriginal = vi.spyOn(originalGeometry, 'dispose');
    const disposePaint = vi.spyOn(paintDisplayGeometry, 'dispose');
    let resolvePatch!: (result: ModelScenePatchResult) => void;
    const getModelScenePatch = vi.fn(() => new Promise<ModelScenePatchResult>((resolve) => {
      resolvePatch = resolve;
    }));
    const pending = readSceneDeltaProjection({ getModelScenePatch }, {
      ...delta([10], ['plate-a']), objectIds: [10], volumeIds: [110], instanceIds: [210],
    }, [structure(10, 0)], [current]);
    await Promise.resolve();

    expect(getModelScenePatch).toHaveBeenCalledWith([10], ['original:110'], ['paint:110:v1']);
    current.dispose();
    expect(retainedPaintGeometry('paint:110:v1')).toBeDefined();
    expect(disposeOriginal).not.toHaveBeenCalled();
    expect(disposePaint).not.toHaveBeenCalled();

    resolvePatch(paintedPatch('original:110', 'paint:110:v1'));
    const projection = await pending;
    expect(projection.volumes[0].geometry).toBe(originalGeometry);
    expect(projection.volumes[0].paintGeometry).toBe(paintDisplayGeometry);
    expect(disposeOriginal).not.toHaveBeenCalled();
    expect(disposePaint).not.toHaveBeenCalled();
    projection.volumes[0].dispose();
    expect(disposeOriginal).toHaveBeenCalledOnce();
    expect(disposePaint).toHaveBeenCalledOnce();
    expect(retainedPaintGeometry('paint:110:v1')).toBeUndefined();
  });

  it('rejects a missing paint resource before publishing a touched model', () => {
    const [current] = projectFullModelMesh(paintedFullResult('paint:110:v1'));
    const originalGeometry = current.geometry;
    expect(() => composeSceneDeltaProjection(
      { ...delta([10], ['plate-a']), objectIds: [10], volumeIds: [110], instanceIds: [210] },
      paintedPatch('original:110', 'paint:110:missing'),
      [structure(10, 0)], [current],
    )).toThrow('missing model paint geometry paint:110:missing');
    expect(current.geometry).toBe(originalGeometry);
    expect(current.paintGeometryKey).toBe('paint:110:v1');
    expect(retainedPaintGeometry('paint:110:missing')).toBeUndefined();
    current.dispose();
  });

  it('uses new original and paint resources together when the source mesh key changes', () => {
    const [current] = projectFullModelMesh(paintedFullResult('paint:110:v1'));
    const oldOriginalGeometry = current.geometry;
    const oldPaintGeometry = current.paintGeometry;
    const updated = composeSceneDeltaProjection(
      { ...delta([10], ['plate-a']), objectIds: [10], volumeIds: [111], instanceIds: [210] },
      paintedPatch('original:111', 'paint:111:v2', [
        { geometryKey: 'original:111', volumeId: 111, positions: new Float32Array([4, 0, 0, 5, 0, 0, 4, 1, 0]),
          indices: new Uint32Array([0, 1, 2]), vertexCount: 3, indexCount: 3 },
      ], [paintGeometry('paint:111:v2', 111, 4)], 4, 111),
      [structure(10, 0)], [current],
    );
    expect(updated.volumes[0].geometry).not.toBe(oldOriginalGeometry);
    expect(updated.volumes[0].paintGeometry).not.toBe(oldPaintGeometry);
    current.dispose();
    updated.volumes[0].dispose();
  });

  it('restores the paint version on scene-patch undo and redo without reusing stale geometry', async () => {
    let volumes = projectFullModelMesh(paintedFullResult('paint:110:v1'));
    const originalGeometry = volumes[0]!.geometry;
    const firstPaint = volumes[0]!.paintGeometry;
    const responses = [
      paintedPatch('original:110', 'paint:110:v2', [], [paintGeometry('paint:110:v2', 110, 3)]),
      paintedPatch('original:110', 'paint:110:v1', [], [paintGeometry('paint:110:v1', 110, 0)]),
      paintedPatch('original:110', 'paint:110:v2', [], [paintGeometry('paint:110:v2', 110, 3)]),
    ];
    const getModelScenePatch = vi.fn(async () => responses.shift()!);
    const applyHistoryPatch = async () => {
      const previous = volumes;
      const projection = await readSceneDeltaProjection({ getModelScenePatch }, {
        ...delta([10], ['plate-a']), objectIds: [10], volumeIds: [110], instanceIds: [210],
      }, [structure(10, 0)], previous);
      projection.apply();
      volumes = projection.volumes;
      previous.forEach((volume) => volume.dispose());
    };

    await applyHistoryPatch();
    const mutationPaint = volumes[0]!.paintGeometry;
    expect(volumes[0]!.paintGeometryKey).toBe('paint:110:v2');
    expect(mutationPaint).not.toBe(firstPaint);
    expect(volumes[0]!.geometry).toBe(originalGeometry);
    expect(retainedPaintGeometry('paint:110:v1')).toBeUndefined();

    await applyHistoryPatch();
    const undoPaint = volumes[0]!.paintGeometry;
    expect(volumes[0]!.paintGeometryKey).toBe('paint:110:v1');
    expect(undoPaint).not.toBe(firstPaint);
    expect(undoPaint).not.toBe(mutationPaint);
    expect(volumes[0]!.geometry).toBe(originalGeometry);
    expect(retainedPaintGeometry('paint:110:v2')).toBeUndefined();

    await applyHistoryPatch();
    expect(volumes[0]!.paintGeometryKey).toBe('paint:110:v2');
    expect(volumes[0]!.paintGeometry).not.toBe(mutationPaint);
    expect(volumes[0]!.paintGeometry).not.toBe(undoPaint);
    expect(volumes[0]!.geometry).toBe(originalGeometry);
    volumes.forEach((volume) => volume.dispose());
  });
});
