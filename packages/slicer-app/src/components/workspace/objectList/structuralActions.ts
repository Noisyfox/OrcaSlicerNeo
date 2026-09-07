import type { SlicerRuntime } from '@orca/platform-contract';
import {
  refreshAfterModelMutation,
  waitForPendingModelTransforms,
  type MutationOutcome,
} from './actions';
import { runProjectHistoryMutation } from '../actions/historyMutation';

/**
 * Structural (geometry-changing) object/part actions. Each calls the matching
 * bridge operation, then runs the unified post-mutation refresh (slice
 * invalidation, structure reload, mesh reload). Selection after a structural
 * change is intentionally cleared by the caller's mesh reload (the viewport
 * purges stale IDs); the full spec §6 restoration rules (select the new
 * entities / delete-neighbour) are a later UI refinement.
 */
export async function deleteObjectsInList(runtime: SlicerRuntime, objectIds: number[]): Promise<MutationOutcome> {
  const settled = await waitForPendingModelTransforms();
  if (!settled.ok) return settled;
  const r = (await runProjectHistoryMutation(runtime, 'Delete Objects', () => runtime.deleteObjects(objectIds))).result;
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime, true, r.plateSession, 'model-delete');
  return { ok: true };
}

export async function deleteVolumeInList(runtime: SlicerRuntime, volumeId: number): Promise<MutationOutcome> {
  const settled = await waitForPendingModelTransforms();
  if (!settled.ok) return settled;
  const r = (await runProjectHistoryMutation(runtime, 'Delete Part', () => runtime.deleteVolumes([volumeId]))).result;
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime, true, r.plateSession, 'model-delete');
  return { ok: true };
}

export async function cloneObjectsInList(runtime: SlicerRuntime, objectIds: number[]): Promise<MutationOutcome> {
  const settled = await waitForPendingModelTransforms();
  if (!settled.ok) return settled;
  const r = (await runProjectHistoryMutation(runtime, 'Clone Objects', () => runtime.cloneObjects(objectIds))).result;
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime, true);
  return { ok: true };
}

export async function splitVolumeToPartsInList(runtime: SlicerRuntime, volumeId: number): Promise<MutationOutcome> {
  const settled = await waitForPendingModelTransforms();
  if (!settled.ok) return settled;
  const r = (await runProjectHistoryMutation(runtime, 'Split to Parts', () => runtime.splitVolumeToParts(volumeId))).result;
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime, true);
  return { ok: true };
}

export async function splitObjectToObjectsInList(runtime: SlicerRuntime, objectId: number): Promise<MutationOutcome> {
  const settled = await waitForPendingModelTransforms();
  if (!settled.ok) return settled;
  const r = (await runProjectHistoryMutation(runtime, 'Split to Objects', () => runtime.splitObjectToObjects(objectId))).result;
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime, true);
  return { ok: true };
}

export async function assembleObjectsInList(runtime: SlicerRuntime, objectIds: number[], name = 'Assembly'): Promise<MutationOutcome> {
  const settled = await waitForPendingModelTransforms();
  if (!settled.ok) return settled;
  const r = (await runProjectHistoryMutation(runtime, 'Assemble Objects', () => runtime.mergeObjectsToMultipart(objectIds, name))).result;
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime, true);
  return { ok: true };
}

export async function separateInstancesInList(runtime: SlicerRuntime, objectId: number, instanceIds: number[]): Promise<MutationOutcome> {
  const settled = await waitForPendingModelTransforms();
  if (!settled.ok) return settled;
  const r = (await runProjectHistoryMutation(runtime, 'Separate Instances', () => runtime.separateInstances(objectId, instanceIds))).result;
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime, true);
  return { ok: true };
}

export async function reorderObjectsInList(runtime: SlicerRuntime, fromObjectId: number, toIndex: number): Promise<MutationOutcome> {
  const settled = await waitForPendingModelTransforms();
  if (!settled.ok) return settled;
  const r = (await runProjectHistoryMutation(runtime, 'Reorder Objects', () => runtime.reorderObjects(fromObjectId, toIndex))).result;
  if (!r.ok) return { ok: false, error: r.error };
  // Reordering objects changes their positional indices. The viewport mesh
  // buffers are keyed by those indices, so reload them to keep the scene, the
  // selection, and the ObjectList structure in the same index space (otherwise
  // the selection-to-list highlight maps to the wrong row).
  await refreshAfterModelMutation(runtime, true);
  return { ok: true };
}

export async function reorderVolumesInList(runtime: SlicerRuntime, objectId: number, fromVolumeId: number, toIndex: number): Promise<MutationOutcome> {
  const settled = await waitForPendingModelTransforms();
  if (!settled.ok) return settled;
  const r = (await runProjectHistoryMutation(runtime, 'Reorder Parts', () => runtime.reorderVolumes(objectId, fromVolumeId, toIndex))).result;
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime, true);
  return { ok: true };
}

export async function addInstanceInList(runtime: SlicerRuntime, objectId: number): Promise<MutationOutcome> {
  const settled = await waitForPendingModelTransforms();
  if (!settled.ok) return settled;
  const r = (await runProjectHistoryMutation(runtime, 'Add Instance', () => runtime.addInstance(objectId))).result;
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime, true);
  return { ok: true };
}

export async function removeInstanceInList(runtime: SlicerRuntime, objectId: number, instanceId: number): Promise<MutationOutcome> {
  const settled = await waitForPendingModelTransforms();
  if (!settled.ok) return settled;
  const r = (await runProjectHistoryMutation(runtime, 'Remove Instance', () => runtime.removeInstance(objectId, instanceId))).result;
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime, true);
  return { ok: true };
}
