import type { SlicerRuntime } from '@orca/platform-contract';
import type { VolumeType } from '@slicer/client';
import type { PlateSessionMutation } from '@slicer/client';
import { useObjectListStore } from './useObjectListStore';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { waitForSettledModelTransforms } from '../actions/persistModelTransforms';
import { useProjectStore } from '../../../stores/useProjectStore';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { applyPlateResultMutation } from '../../../stores/plateResultLifecycle';
import { applyPlateSessionTransforms } from '../actions/syncModelTransforms';
import { glVolumeCollection } from '../viewport/GLVolume';
import { runProjectHistoryMutation, syncHistoryStatus } from '../actions/historyMutation';

export interface MutationOutcome {
  ok: boolean;
  error?: string;
}

/**
 * Structural and metadata mutations use positional model indices. Drain the
 * transform queue before changing those indices so an older snapshot cannot
 * arrive after the mutation and overwrite the wrong object or part.
 */
export async function waitForPendingModelTransforms(): Promise<MutationOutcome> {
  try {
    const settled = await waitForSettledModelTransforms();
    if (!settled.ok) {
      return {
        ok: false,
        error: settled.error ?? 'Unable to persist pending model transforms',
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Unified post-mutation refresh (spec §8):
 *   1. invalidate the slice/export result (the bridge already cleared its C++
 *      Print; mirror that in the renderer state),
 *   2. re-read the structure into the ObjectList store,
 *   3. re-fetch the viewport mesh when the mutation changed geometry (e.g. a
 *      volume type change), so the list, viewport, and slice state agree.
 * Selection restoration by stable ID is handled by the caller (the store keeps
 * the prior projection; the viewport purges stale volumes on reload).
 */
export async function refreshAfterModelMutation(
  runtime: SlicerRuntime,
  geometryChanged = false,
  plateSession?: PlateSessionMutation,
  dirtyReason: 'model-delete' | 'model-structure' = 'model-structure',
): Promise<void> {
  const slicer = useSlicerStore.getState();
  slicer.setStatus('idle');
  slicer.setResultExported(false);
  slicer.setError(null);
  slicer.setLayers(0);
  if (geometryChanged) useSettingsStore.getState().refreshModel();
  if (plateSession) {
    applyPlateSessionTransforms(plateSession, glVolumeCollection.volumes);
    const previousPlateSession = usePlateSessionStore.getState().snapshot;
    usePlateSessionStore.getState().setSnapshot(plateSession);
    applyPlateResultMutation(plateSession, previousPlateSession);
    useProjectStore.getState().recordPlateMutation(plateSession);
  } else {
    useProjectStore.getState().markDirty(dirtyReason);
  }
  const structure = await runtime.getModelStructure();
  if (structure.ok && structure.objects) {
    useObjectListStore.getState().setStructure(structure.objects);
    useObjectListStore.getState().setLoaded(true);
    if (structure.objects.length === 0) {
      useSettingsStore.getState().setModelLoaded(false);
      useProjectStore.getState().setProject({ hasContent: false });
    } else {
      useProjectStore.getState().setProject({ hasContent: true });
    }
  }
  await syncHistoryStatus(runtime);
}

export async function renameObjectInList(runtime: SlicerRuntime, objectId: number, name: string): Promise<MutationOutcome> {
  const settled = await waitForPendingModelTransforms();
  if (!settled.ok) return settled;
  // Orca: renaming a single-volume object renames its only part too, keeping
  // the part name in sync with the object name.
  const obj = useObjectListStore.getState().structure.find((o) => o.id === objectId);
  const history = await runProjectHistoryMutation(runtime, 'Rename Object', async () => {
    const r = await runtime.renameObject(objectId, name);
    if (!r.ok) return r;
    if (obj && obj.volumes.length === 1) {
      const v = await runtime.renameVolume(obj.volumes[0].id, name);
      if (!v.ok) return v;
    }
    return r;
  });
  const r = history.result;
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime);
  return { ok: true };
}

export async function renamePartInList(runtime: SlicerRuntime, volumeId: number, name: string): Promise<MutationOutcome> {
  const settled = await waitForPendingModelTransforms();
  if (!settled.ok) return settled;
  const r = (await runProjectHistoryMutation(runtime, 'Rename Part', () => runtime.renameVolume(volumeId, name))).result;
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime);
  return { ok: true };
}

export async function changePartTypeInList(runtime: SlicerRuntime, volumeId: number, type: VolumeType): Promise<MutationOutcome> {
  const settled = await waitForPendingModelTransforms();
  if (!settled.ok) return settled;
  const r = (await runProjectHistoryMutation(runtime, 'Change Part Type', () => runtime.setVolumeType(volumeId, type))).result;
  if (!r.ok) return { ok: false, error: r.error };
  // Changing a part's type alters which volumes compose the print mesh.
  await refreshAfterModelMutation(runtime, true);
  return { ok: true };
}

/** Toggle printable on one object or the whole multi-selection (the caller
 *  resolves the targets from the current projection). The runtime API is
 *  single-id, so the loop runs the sequential bridge calls and the structure
 *  refresh happens once after all of them. */
export async function setObjectPrintableInList(runtime: SlicerRuntime, objectIds: number[], printable: boolean): Promise<MutationOutcome> {
  const settled = await waitForPendingModelTransforms();
  if (!settled.ok) return settled;
  const r = (await runProjectHistoryMutation(runtime, 'Change Printable', async () => {
    for (const objectId of objectIds) {
      const result = await runtime.setObjectPrintable(objectId, printable);
      if (!result.ok) return result;
    }
    return { ok: true };
  })).result;
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime);
  return { ok: true };
}

export async function setInstancePrintableInList(runtime: SlicerRuntime, instanceIds: number[], printable: boolean): Promise<MutationOutcome> {
  const settled = await waitForPendingModelTransforms();
  if (!settled.ok) return settled;
  const r = (await runProjectHistoryMutation(runtime, 'Change Printable', async () => {
    for (const instanceId of instanceIds) {
      const result = await runtime.setInstancePrintable(instanceId, printable);
      if (!result.ok) return result;
    }
    return { ok: true };
  })).result;
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime);
  return { ok: true };
}
