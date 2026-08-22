import type { SlicerRuntime } from '@orca/platform-contract';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { waitForSettledModelTransforms } from './persistModelTransforms';

export type DeleteSelectionResult = { ok: boolean; error?: string };

/**
 * Delete the complete objects that own the current selection (selection is
 * instance-based; native OrcaSlicer's Delete removes whole objects).
 *
 * A successful delete invalidates the sliced result and refreshes the
 * viewport model: an empty plate flips `modelLoaded` off (slice/clear
 * disable), otherwise the loader re-fetches the mesh on a revision bump.
 */
export async function deleteSelectedObjects(
  runtime: SlicerRuntime,
  objectIndices: number[],
): Promise<DeleteSelectionResult> {
  if (objectIndices.length === 0) return { ok: true };
  try {
    // A just-finished drag commits its settled transforms on pointer release;
    // wait for that commit so a delete cannot race a transform sync for an
    // object that is about to disappear (same discipline as Add Model).
    const synced = await waitForSettledModelTransforms();
    if (!synced.ok) return synced;
    const r = await runtime.deleteObjects(objectIndices);
    if (!r.ok) throw new Error(r.error ?? 'delete failed');
    const slicer = useSlicerStore.getState();
    const settings = useSettingsStore.getState();
    // A model mutation makes any completed slice/G-code result stale.
    slicer.setStatus('idle');
    slicer.setResultExported(false);
    slicer.setError(null);
    if ((r.objects ?? 0) === 0) settings.setModelLoaded(false);
    else settings.refreshModel();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useSlicerStore.getState().setError(message);
    return { ok: false, error: message };
  }
}
