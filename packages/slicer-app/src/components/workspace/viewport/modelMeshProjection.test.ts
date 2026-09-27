import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelMeshResult, ModelPaintGeometry, NativeModelObjectBuffer } from '@slicer/client';
import { glVolumeCollection, retainedGeometry, retainedPaintGeometry } from './GLVolume';
import { projectFullModelMesh } from './modelMeshProjection';

function modelObject(instanceId: number, x: number, paintGeometryKey: string | null): NativeModelObjectBuffer {
  return {
    objectId: 10,
    volumeId: 110,
    instanceId,
    objectIdx: 0,
    volumeIdx: 0,
    instanceIdx: instanceId - 210,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    vertexCount: 3,
    indices: new Uint32Array([0, 1, 2]),
    indexCount: 3,
    offset: [0, 0, 0],
    instanceTransform: { offset: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] },
    volumeTransform: { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] },
    geometryKey: 'original:110',
    paintGeometryKey,
  };
}

function paintGeometry(): ModelPaintGeometry {
  return {
    paintGeometryKey: 'paint:110:v1',
    volumeId: 110,
    positions: new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      1, 0, 0, 1, 1, 0, 0, 1, 0,
    ]),
    vertexCount: 6,
    indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    indexCount: 6,
    drawGroups: [
      { stateId: 0, startIndex: 0, indexCount: 3 },
      { stateId: 3, startIndex: 3, indexCount: 3 },
    ],
  };
}

function fullMesh(): ModelMeshResult {
  return {
    ok: true,
    objects: [modelObject(210, 0, 'paint:110:v1'), modelObject(211, 5, 'paint:110:v1')],
    paintGeometries: [paintGeometry()],
  };
}

describe('full model mesh projection', () => {
  afterEach(() => glVolumeCollection.clear(glVolumeCollection.revision + 1));

  it('builds one grouped paint geometry shared by instances without adding a paint BVH', () => {
    const volumes = projectFullModelMesh(fullMesh());
    const [first, second] = volumes;

    expect(first.geometry).toBe(second.geometry);
    expect(first.paintGeometry).toBe(second.paintGeometry);
    expect(first.paintGeometry?.groups).toEqual([
      { start: 0, count: 3, materialIndex: 0 },
      { start: 3, count: 3, materialIndex: 1 },
    ]);
    expect(first.paintDrawGroups.map((group) => group.stateId)).toEqual([0, 3]);
    expect(first.paintGeometry && 'boundsTree' in first.paintGeometry).toBe(false);
    expect(first.paintGeometry && 'computeBoundsTree' in first.paintGeometry).toBe(false);
    expect('boundsTree' in first.geometry).toBe(true);
    expect(first.geometry).not.toBe(first.paintGeometry);
    expect(first.instanceTransform).not.toBe(second.instanceTransform);
    expect(first.instanceTransform.offset).toEqual([0, 0, 0]);
    expect(second.instanceTransform.offset).toEqual([5, 0, 0]);

    const disposeOriginal = vi.spyOn(first.geometry, 'dispose');
    const disposePaint = vi.spyOn(first.paintGeometry!, 'dispose');
    glVolumeCollection.replace(volumes, 1);
    glVolumeCollection.patch([second], 2);
    expect(disposeOriginal).not.toHaveBeenCalled();
    expect(disposePaint).not.toHaveBeenCalled();
    glVolumeCollection.clear(3);
    expect(disposeOriginal).toHaveBeenCalledOnce();
    expect(disposePaint).toHaveBeenCalledOnce();
    expect(retainedGeometry('original:110')).toBeUndefined();
    expect(retainedPaintGeometry('paint:110:v1')).toBeUndefined();
  });

  it('keeps the published scene intact when a full response is missing a referenced paint resource', () => {
    const existing = projectFullModelMesh({ ...fullMesh(),
      objects: [{ ...modelObject(310, 0, null), geometryKey: 'original:existing' }], paintGeometries: [] })[0]!;
    glVolumeCollection.replace([existing], 10);
    const originalGeometry = existing.geometry;
    const malformed = {
      ...fullMesh(),
      objects: [modelObject(210, 0, 'paint:110:v1'), modelObject(211, 5, 'paint:110:missing')],
    };

    expect(() => {
      const next = projectFullModelMesh(malformed);
      glVolumeCollection.replace(next, 11);
    }).toThrow('missing model paint geometry paint:110:missing');
    expect(glVolumeCollection.volumes).toEqual([existing]);
    expect(existing.geometry).toBe(originalGeometry);
    expect(retainedGeometry('original:110')).toBeUndefined();
    expect(retainedPaintGeometry('paint:110:v1')).toBeUndefined();
  });
});
