import type { SlicerRuntime } from '@orca/platform-contract';
import type { VolumeType } from '@slicer/client';
import { useObjectListStore } from './useObjectListStore';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';

export interface MutationOutcome {
  ok: boolean;
  error?: string;
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
): Promise<void> {
  const slicer = useSlicerStore.getState();
  slicer.setStatus('idle');
  slicer.setResultExported(false);
  slicer.setError(null);
  slicer.setLayers(0);
  if (geometryChanged) useSettingsStore.getState().refreshModel();
  const structure = await runtime.getModelStructure();
  if (structure.ok && structure.objects) {
    useObjectListStore.getState().setStructure(structure.objects);
    useObjectListStore.getState().setLoaded(true);
    if (structure.objects.length === 0) useSettingsStore.getState().setModelLoaded(false);
  }
}

export async function renameObjectInList(runtime: SlicerRuntime, objectId: number, name: string): Promise<MutationOutcome> {
  const r = await runtime.renameObject(objectId, name);
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime);
  return { ok: true };
}

export async function renamePartInList(runtime: SlicerRuntime, volumeId: number, name: string): Promise<MutationOutcome> {
  const r = await runtime.renameVolume(volumeId, name);
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime);
  return { ok: true };
}

export async function changePartTypeInList(runtime: SlicerRuntime, volumeId: number, type: VolumeType): Promise<MutationOutcome> {
  const r = await runtime.setVolumeType(volumeId, type);
  if (!r.ok) return { ok: false, error: r.error };
  // Changing a part's type alters which volumes compose the print mesh.
  await refreshAfterModelMutation(runtime, true);
  return { ok: true };
}

export async function setObjectPrintableInList(runtime: SlicerRuntime, objectId: number, printable: boolean): Promise<MutationOutcome> {
  const r = await runtime.setObjectPrintable(objectId, printable);
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime);
  return { ok: true };
}

export async function setInstancePrintableInList(runtime: SlicerRuntime, instanceId: number, printable: boolean): Promise<MutationOutcome> {
  const r = await runtime.setInstancePrintable(instanceId, printable);
  if (!r.ok) return { ok: false, error: r.error };
  await refreshAfterModelMutation(runtime);
  return { ok: true };
}
