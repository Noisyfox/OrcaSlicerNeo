import type { SlicerRuntime } from '@orca/platform-contract';
import type { VolumeType } from '@slicer/client';
import type { PlateSessionMutation } from '@slicer/client';
import { useObjectListStore } from './useObjectListStore';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { waitForSettledModelTransforms } from '../actions/persistModelTransforms';
import { useProjectStore } from '../../../stores/useProjectStore';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { applyPlateResultMutation, invalidateAffectedPlateResults } from '../../../stores/plateResultLifecycle';
import { applyPlateSessionTransforms } from '../actions/syncModelTransforms';
import { glVolumeCollection } from '../viewport/GLVolume';
import { runProjectHistoryMutation } from '../actions/historyMutation';

type ListHistoryResult = { ok: boolean; error?: string; plateSession?: PlateSessionMutation };

function mergePlateMutationReceipts(receipts: readonly PlateSessionMutation[]): PlateSessionMutation | undefined {
  const latest = receipts.at(-1);
  if (!latest) return undefined;
  const union = (key: 'affectedPlateIds' | 'affectedPlateIdsBefore' | 'affectedPlateIdsAfter') =>
    [...new Set(receipts.flatMap((receipt) => receipt[key] ?? []))];
  return {
    ...latest,
    affectedPlateIds: union('affectedPlateIds'),
    affectedPlateIdsBefore: union('affectedPlateIdsBefore'),
    affectedPlateIdsAfter: union('affectedPlateIdsAfter'),
  };
}

async function runListHistory(
  runtime: SlicerRuntime,
  label: string,
  mutation: () => Promise<ListHistoryResult>,
): Promise<ListHistoryResult> {
  const history = await runProjectHistoryMutation(runtime, label, mutation, null, {
    publish: async (result) => {
      if (result.ok) await refreshAfterModelMutation(runtime, result.plateSession);
    },
  });
  return history.result;
}

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

/** Publish result/plate state after the committed SceneDelta updated the scene. */
export async function refreshAfterModelMutation(
  runtime: SlicerRuntime,
  plateSession?: PlateSessionMutation,
  dirtyReason: 'model-delete' | 'model-structure' = 'model-structure',
): Promise<void> {
  const slicer = useSlicerStore.getState();
  slicer.setStatus('idle');
  slicer.setResultExported(false);
  slicer.setError(null);
  slicer.setLayers(0);
  if (plateSession) {
    invalidateAffectedPlateResults(runtime, plateSession.affectedPlateIds ?? []);
    if (plateSession.nativeScopedConfig) {
      const outcome = useSettingsStore.getState().applyNativeScopedConfigTransport(plateSession.nativeScopedConfig);
      if (outcome === 'refresh-required') {
        const refreshed = await runtime.getNativeScopedConfig();
        if (refreshed.ok) useSettingsStore.getState().applyNativeScopedConfigTransport(refreshed.nativeScopedConfig);
      }
    }
    applyPlateSessionTransforms(plateSession, glVolumeCollection.volumes);
    const previousPlateSession = usePlateSessionStore.getState().snapshot;
    usePlateSessionStore.getState().setSnapshot(plateSession);
    applyPlateResultMutation(plateSession, previousPlateSession);
    useProjectStore.getState().recordPlateMutation(plateSession);
  } else {
    useProjectStore.getState().markDirty(dirtyReason);
  }
  const structure = useObjectListStore.getState().structure;
  if (structure.length === 0) {
    useSettingsStore.getState().setModelLoadedFromSceneDelta(false);
    useProjectStore.getState().setProject({ hasContent: false });
  } else {
    useProjectStore.getState().setProject({ hasContent: true });
  }
}

export async function renameObjectInList(runtime: SlicerRuntime, objectId: number, name: string): Promise<MutationOutcome> {
  const settled = await waitForPendingModelTransforms();
  if (!settled.ok) return settled;
  // Orca: renaming a single-volume object renames its only part too, keeping
  // the part name in sync with the object name.
  const obj = useObjectListStore.getState().structure.find((o) => o.id === objectId);
  const r = await runListHistory(runtime, 'Rename Object', async () => {
    const r = await runtime.renameObject(objectId, name);
    if (!r.ok) return r;
    if (obj && obj.volumes.length === 1) {
      const v = await runtime.renameVolume(obj.volumes[0].id, name);
      if (!v.ok) return v;
    }
    return r;
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true };
}

export async function renamePartInList(runtime: SlicerRuntime, volumeId: number, name: string): Promise<MutationOutcome> {
  const settled = await waitForPendingModelTransforms();
  if (!settled.ok) return settled;
  const r = await runListHistory(runtime, 'Rename Part', () => runtime.renameVolume(volumeId, name));
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true };
}

export async function changePartTypeInList(runtime: SlicerRuntime, volumeId: number, type: VolumeType): Promise<MutationOutcome> {
  const settled = await waitForPendingModelTransforms();
  if (!settled.ok) return settled;
  const r = await runListHistory(runtime, 'Change Part Type', () => runtime.setVolumeType(volumeId, type));
  if (!r.ok) return { ok: false, error: r.error };
  // Changing a part's type alters which volumes compose the print mesh.
  return { ok: true };
}

/** Toggle printable on one object or the whole multi-selection (the caller
 *  resolves the targets from the current projection). The runtime API is
 *  single-id, so the loop runs the sequential bridge calls and the structure
 *  refresh happens once after all of them. */
export async function setObjectPrintableInList(runtime: SlicerRuntime, objectIds: number[], printable: boolean): Promise<MutationOutcome> {
  const settled = await waitForPendingModelTransforms();
  if (!settled.ok) return settled;
  const receipts: PlateSessionMutation[] = [];
  const r = await runListHistory(runtime, 'Change Printable', async () => {
    for (const objectId of objectIds) {
      const result = await runtime.setObjectPrintable(objectId, printable);
      if (!result.ok) return result;
      if (result.plateSession) receipts.push(result.plateSession);
    }
    return { ok: true, plateSession: mergePlateMutationReceipts(receipts) };
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true };
}

export async function setInstancePrintableInList(runtime: SlicerRuntime, instanceIds: number[], printable: boolean): Promise<MutationOutcome> {
  const settled = await waitForPendingModelTransforms();
  if (!settled.ok) return settled;
  const receipts: PlateSessionMutation[] = [];
  const r = await runListHistory(runtime, 'Change Printable', async () => {
    for (const instanceId of instanceIds) {
      const result = await runtime.setInstancePrintable(instanceId, printable);
      if (!result.ok) return result;
      if (result.plateSession) receipts.push(result.plateSession);
    }
    return { ok: true, plateSession: mergePlateMutationReceipts(receipts) };
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true };
}
