import type { SlicerRuntime } from '@orca/platform-contract';
import { refreshAfterModelMutation, type MutationOutcome } from './actions';

/**
 * Structural (geometry-changing) object/part actions. Each calls the matching
 * bridge operation, then runs the unified post-mutation refresh (slice
 * invalidation, structure reload, mesh reload). Selection after a structural
 * change is intentionally cleared by the caller's mesh reload (the viewport
 * purges stale IDs); the full spec §6 restoration rules (select the new
 * entities / delete-neighbour) are a later UI refinement.
 */
export async function deleteObjectsInList(runtime: SlicerRuntime, objectIds: number[]): Promise<MutationOutcome> {
  const r = await runtime.deleteObjects(objectIds);
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime, true);
  return { ok: true };
}

export async function deleteVolumeInList(runtime: SlicerRuntime, volumeId: number): Promise<MutationOutcome> {
  const r = await runtime.deleteVolumes([volumeId]);
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime, true);
  return { ok: true };
}

export async function cloneObjectsInList(runtime: SlicerRuntime, objectIds: number[]): Promise<MutationOutcome> {
  const r = await runtime.cloneObjects(objectIds);
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime, true);
  return { ok: true };
}

export async function splitVolumeToPartsInList(runtime: SlicerRuntime, volumeId: number): Promise<MutationOutcome> {
  const r = await runtime.splitVolumeToParts(volumeId);
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime, true);
  return { ok: true };
}

export async function splitObjectToObjectsInList(runtime: SlicerRuntime, objectId: number): Promise<MutationOutcome> {
  const r = await runtime.splitObjectToObjects(objectId);
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime, true);
  return { ok: true };
}

export async function assembleObjectsInList(runtime: SlicerRuntime, objectIds: number[], name = 'Assembly'): Promise<MutationOutcome> {
  const r = await runtime.mergeObjectsToMultipart(objectIds, name);
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime, true);
  return { ok: true };
}

export async function separateInstancesInList(runtime: SlicerRuntime, objectId: number, instanceIds: number[]): Promise<MutationOutcome> {
  const r = await runtime.separateInstances(objectId, instanceIds);
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime, true);
  return { ok: true };
}

export async function reorderObjectsInList(runtime: SlicerRuntime, fromObjectId: number, toObjectId: number): Promise<MutationOutcome> {
  const r = await runtime.reorderObjects(fromObjectId, toObjectId);
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime);
  return { ok: true };
}

export async function reorderVolumesInList(runtime: SlicerRuntime, objectId: number, fromVolumeId: number, toVolumeId: number): Promise<MutationOutcome> {
  const r = await runtime.reorderVolumes(objectId, fromVolumeId, toVolumeId);
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime);
  return { ok: true };
}

export async function addInstanceInList(runtime: SlicerRuntime, objectId: number): Promise<MutationOutcome> {
  const r = await runtime.addInstance(objectId);
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime, true);
  return { ok: true };
}

export async function removeInstanceInList(runtime: SlicerRuntime, objectId: number, instanceId: number): Promise<MutationOutcome> {
  const r = await runtime.removeInstance(objectId, instanceId);
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime, true);
  return { ok: true };
}
