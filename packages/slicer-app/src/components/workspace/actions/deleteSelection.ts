import type { SlicerRuntime } from '@orca/platform-contract';
import type { ModelObjectStructure } from '@slicer/client';
import type { PlateSessionMutation } from '@slicer/client';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import { waitForSettledModelTransforms } from './persistModelTransforms';
import { applyPlateSessionTransforms } from './syncModelTransforms';
import { glVolumeCollection } from '../viewport/GLVolume';

export type DeleteSelectionResult = { ok: boolean; error?: string };

/** Unique selected volume IDs across every instance (a volume is shared by the object's instances). */
function collectSelectedVolumeIds(
  objects: ModelObjectStructure[],
  selected: readonly { buffer: { objectIdx: number; volumeIdx: number } }[],
): number[] {
  const ids = new Map<string, number>();
  for (const volume of selected) {
    const obj = objects[volume.buffer.objectIdx];
    const vol = obj?.volumes[volume.buffer.volumeIdx];
    if (vol) ids.set(`${volume.buffer.objectIdx}:${volume.buffer.volumeIdx}`, vol.id);
  }
  return [...ids.values()];
}

function collectSelectedObjectIds(objects: ModelObjectStructure[], objectIndices: number[]): number[] {
  const idByIndex = new Map(objects.map((o) => [o.index, o.id] as const));
  return objectIndices.flatMap((i) => {
    const id = idByIndex.get(i);
    return id === undefined ? [] : [id];
  });
}

/**
 * Delete the current selection. When the selection is part-scoped (some instance
 * has only a subset of its volumes selected), it deletes the selected PARTS
 * (volumes); otherwise it deletes the whole objects behind the selection. Each
 * delete invalidates the slice/export result and refreshes the structure + mesh.
 */
export async function deleteSelection(
  runtime: SlicerRuntime,
  sceneInteraction: SceneInteractionController,
): Promise<DeleteSelectionResult> {
  const selected = sceneInteraction.selectedVolumes();
  const objectIndices = sceneInteraction.selectedObjectIndices();
  if (selected.length === 0 || objectIndices.length === 0) return { ok: true };
  try {
    const synced = await waitForSettledModelTransforms();
    if (!synced.ok) return synced;
    const structure = await runtime.getModelStructure();
    if (!structure.ok || !structure.objects) {
      const msg = structure.error ?? 'structure unavailable';
      useSlicerStore.getState().setError(msg);
      return { ok: false, error: msg };
    }
    const volumeScoped = sceneInteraction.isVolumeScopedSelection();
    let result: { ok: boolean; objects?: number; error?: string; plateSession?: PlateSessionMutation };
    if (volumeScoped) {
      const volumeIds = collectSelectedVolumeIds(structure.objects, selected);
      if (volumeIds.length === 0) {
        const msg = 'selection no longer matches the model';
        useSlicerStore.getState().setError(msg);
        return { ok: false, error: msg };
      }
      result = await runtime.deleteVolumes(volumeIds);
    } else {
      const objectIds = collectSelectedObjectIds(structure.objects, objectIndices);
      if (objectIds.length === 0) {
        const msg = 'selection no longer matches the model';
        useSlicerStore.getState().setError(msg);
        return { ok: false, error: msg };
      }
      result = await runtime.deleteObjects(objectIds);
    }
    if (!result.ok) throw new Error(result.error ?? 'delete failed');
    applyPlateSessionTransforms(result.plateSession, glVolumeCollection.volumes);
    const slicer = useSlicerStore.getState();
    const settings = useSettingsStore.getState();
    slicer.setStatus('idle');
    slicer.setResultExported(false);
    slicer.setError(null);
    if ((result.objects ?? 0) === 0) {
      settings.setModelLoaded(false);
      useProjectStore.getState().setProject({ hasContent: false });
    }
    else settings.refreshModel();
    useProjectStore.getState().markDirty('model-delete');
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useSlicerStore.getState().setError(message);
    return { ok: false, error: message };
  }
}
