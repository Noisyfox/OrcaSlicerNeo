import type {
  ModelObjectBuffer,
  ModelObjectStructure,
  ModelScenePatchResult,
  SceneDelta,
  SlicerClient,
} from '@slicer/client';
import { GLVolume } from './GLVolume';
import { normalizeTransform } from './transformDeltaMath';

export type SceneDeltaProjection = {
  structure: ModelObjectStructure[];
  volumes: GLVolume[];
};

function sameIds(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function meshKey(objectId: number, volumeId: number, instanceId: number): string {
  return `${objectId}:${volumeId}:${instanceId}`;
}

function bufferKey(buffer: ModelObjectBuffer): string {
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
  const patchBuffers = new Map<string, ModelObjectBuffer>();
  for (const buffer of patch.meshes) {
    if (!touched.has(buffer.objectId))
      throw new Error(`model scene patch returned untouched object ${buffer.objectId}`);
    const key = bufferKey(buffer);
    if (patchBuffers.has(key)) throw new Error(`model scene patch duplicated mesh ${key}`);
    patchBuffers.set(key, buffer);
  }

  const ordered: Array<{
    candidate: GLVolume | ModelObjectBuffer;
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

  const created: GLVolume[] = [];
  let volumes: GLVolume[];
  try {
    volumes = ordered.map(({ candidate, objectIdx, volumeIdx, instanceIdx }) => {
      const buffer = candidate instanceof GLVolume ? candidate.buffer : candidate;
      buffer.objectIdx = objectIdx;
      buffer.volumeIdx = volumeIdx;
      buffer.instanceIdx = instanceIdx;
      if (candidate instanceof GLVolume) return candidate;
      const volume = new GLVolume(candidate);
      created.push(volume);
      return volume;
    });
  } catch (error) {
    created.forEach((volume) => volume.dispose());
    throw error;
  }
  return { structure, volumes };
}

export async function readSceneDeltaProjection(
  runtime: Pick<SlicerClient, 'getModelScenePatch'>,
  delta: SceneDelta,
  currentStructure: readonly ModelObjectStructure[],
  currentVolumes: readonly GLVolume[],
): Promise<SceneDeltaProjection> {
  const retained = new Set(delta.retainedRendererObjectIds ?? []);
  const projectionDelta = { ...delta, objectIds: delta.objectIds.filter((id) => !retained.has(id)) };
  const patch = await runtime.getModelScenePatch(projectionDelta.objectIds);
  const projection = composeSceneDeltaProjection(projectionDelta, patch, currentStructure, currentVolumes);
  const transforms = new Map((delta.retainedVolumeTransforms ?? []).map((item) => [item.volumeId, item.transform]));
  for (const volume of projection.volumes) {
    const transform = transforms.get(volume.buffer.volumeId);
    if (transform) volume.volumeTransform = normalizeTransform(structuredClone(transform));
  }
  return projection;
}
