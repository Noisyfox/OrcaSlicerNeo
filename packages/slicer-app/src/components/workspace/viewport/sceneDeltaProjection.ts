import type {
  ModelObjectBuffer,
  ModelRenderable,
  ModelObjectStructure,
  ModelPaintGeometry,
  ModelScenePatchResult,
  SceneDelta,
  SlicerClient,
} from '@slicer/client';
import {
  GLVolume,
  leaseGeometry,
  leasePaintGeometry,
  retainedGeometry,
  retainedPaintGeometry,
} from './GLVolume';
import { normalizeTransform } from './transformDeltaMath';

export type SceneDeltaProjection = {
  structure: ModelObjectStructure[];
  volumes: GLVolume[];
  apply: () => void;
};

function sameIds(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function meshKey(objectId: number, volumeId: number, instanceId: number): string {
  return `${objectId}:${volumeId}:${instanceId}`;
}

function bufferKey(buffer: ModelRenderable): string {
  return meshKey(buffer.objectId, buffer.volumeId, buffer.instanceId);
}

/**
 * Validate and compose one native stable-ID patch without mutating the live
 * collection. The caller publishes the returned structure/volumes together;
 * any invariant failure leaves the prior React/Three scene untouched.
 */
export function composeSceneDeltaProjection(
  delta: SceneDelta,
  patch: ModelScenePatchResult,
  currentStructure: readonly ModelObjectStructure[],
  currentVolumes: readonly GLVolume[],
): SceneDeltaProjection {
  if (!patch.ok) throw new Error(patch.error ?? 'model scene patch failed');
  if (!sameIds(patch.objectOrder, delta.objectOrder))
    throw new Error('model scene patch order does not match history delta');

  const touched = new Set(delta.objectIds);
  const expectedTouched = delta.objectOrder.filter((id) => touched.has(id));
  const patchIds = patch.objects.map((object) => object.id);
  if (!sameIds(patchIds, expectedTouched))
    throw new Error('model scene patch structure does not match touched object ids');

  const structureById = new Map(currentStructure.map((object) => [object.id, object]));
  for (const object of patch.objects) structureById.set(object.id, object);
  const structure = delta.objectOrder.map((id, index) => {
    const object = structureById.get(id);
    if (!object) throw new Error(`model scene patch is missing object ${id}`);
    return object.index === index ? object : { ...object, index };
  });

  const retainedMeshes = new Map(currentVolumes.map((volume) => [volume.id, volume]));
  const patchBuffers = new Map<string, ModelRenderable>();
  for (const buffer of patch.meshes) {
    if (!touched.has(buffer.objectId))
      throw new Error(`model scene patch returned untouched object ${buffer.objectId}`);
    const key = bufferKey(buffer);
    if (patchBuffers.has(key)) throw new Error(`model scene patch duplicated mesh ${key}`);
    patchBuffers.set(key, buffer);
  }

  const ordered: Array<{
    candidate: GLVolume | ModelRenderable;
    objectIdx: number;
    volumeIdx: number;
    instanceIdx: number;
  }> = [];
  for (const object of structure) {
    for (const volume of object.volumes) {
      for (const instance of object.instances) {
        const key = meshKey(object.id, volume.id, instance.id);
        const candidate = touched.has(object.id) ? patchBuffers.get(key) : retainedMeshes.get(key);
        if (!candidate) throw new Error(`model scene patch is missing mesh ${key}`);
        ordered.push({
          candidate, objectIdx: object.index, volumeIdx: volume.index, instanceIdx: instance.index,
        });
        patchBuffers.delete(key);
      }
    }
  }
  if (patchBuffers.size > 0) throw new Error('model scene patch returned unreferenced meshes');

  const resources = new Map(patch.geometries.map((geometry) => [geometry.geometryKey, geometry]));
  if (resources.size !== patch.geometries.length) throw new Error('duplicate model geometry');
  const responsePaintGeometries = patch.paintGeometries;
  const paintResources = new Map<string, ModelPaintGeometry>(
    responsePaintGeometries.map((geometry) => [geometry.paintGeometryKey, geometry]),
  );
  if (paintResources.size !== responsePaintGeometries.length) throw new Error('duplicate model paint geometry');
  const created: GLVolume[] = [];
  const updates: Array<() => void> = [];
  try {
    const volumes = ordered.map(({ candidate, objectIdx, volumeIdx, instanceIdx }) => {
      if (candidate instanceof GLVolume) {
        updates.push(() => Object.assign(candidate.buffer, { objectIdx, volumeIdx, instanceIdx }));
        return candidate;
      }
      const resource = resources.get(candidate.geometryKey) ?? retainedGeometry(candidate.geometryKey);
      if (!resource || resource.volumeId !== candidate.volumeId)
        throw new Error(`missing model geometry ${candidate.geometryKey}`);
      let paint: ModelPaintGeometry | undefined;
      if (candidate.paintGeometryKey !== null) {
        paint = paintResources.get(candidate.paintGeometryKey) ?? retainedPaintGeometry(candidate.paintGeometryKey);
        if (!paint || paint.volumeId !== candidate.volumeId)
          throw new Error(`missing model paint geometry ${candidate.paintGeometryKey}`);
      }
      const buffer: ModelObjectBuffer = { ...candidate, ...resource, objectIdx, volumeIdx, instanceIdx };
      const volume = new GLVolume(buffer, { kind: 'shared', key: candidate.geometryKey },
        paint ? { key: candidate.paintGeometryKey!, buffer: paint } : undefined);
      created.push(volume);
      return volume;
    });
    return { structure, volumes, apply: () => updates.forEach((update) => update()) };
  } catch (error) {
    created.forEach((volume) => volume.dispose());
    throw error;
  }
}

export async function readSceneDeltaProjection(
  runtime: Pick<SlicerClient, 'getModelScenePatch'>,
  delta: SceneDelta,
  currentStructure: readonly ModelObjectStructure[],
  currentVolumes: readonly GLVolume[],
): Promise<SceneDeltaProjection> {
  const retained = new Set(delta.retainedRendererObjectIds ?? []);
  const projectionDelta = { ...delta, objectIds: delta.objectIds.filter((id) => !retained.has(id)) };
  const touched = new Set(projectionDelta.objectIds);
  const keys = [...new Set(currentVolumes.filter((volume) => touched.has(volume.buffer.objectId))
    .flatMap((volume) => volume.ownership.kind === 'shared' ? [volume.ownership.key] : []))];
  const paintKeys = [...new Set(currentVolumes.filter((volume) => touched.has(volume.buffer.objectId))
    .flatMap((volume) => volume.paintGeometryKey === null ? [] : [volume.paintGeometryKey]))];
  const releaseGeometry = leaseGeometry(keys);
  let releasePaintGeometry = () => {};
  try {
    releasePaintGeometry = leasePaintGeometry(paintKeys);
    const patch = await runtime.getModelScenePatch(projectionDelta.objectIds, keys, paintKeys);
    const projection = composeSceneDeltaProjection(projectionDelta, patch, currentStructure, currentVolumes);
    const transforms = new Map((delta.retainedVolumeTransforms ?? []).map((item) =>
      [item.volumeId, normalizeTransform(structuredClone(item.transform))]));
    const apply = projection.apply;
    projection.apply = () => {
      apply();
      for (const volume of projection.volumes) {
        const transform = transforms.get(volume.buffer.volumeId);
        if (transform) volume.volumeTransform = transform;
      }
    };
    return projection;
  } finally {
    releasePaintGeometry();
    releaseGeometry();
  }
}
