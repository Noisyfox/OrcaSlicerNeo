import type { SlicerRuntime } from '@orca/platform-contract';
import { glVolumeCollection } from '../viewport/GLVolume';
import { applyPlateResultMutation, invalidateAffectedPlateResults, type SliceCancellationRuntime } from '@/stores/plateResultLifecycle';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { applyPlateSessionTransforms, syncModelTransforms, type TransformSyncResult } from './syncModelTransforms';

/** Apply the renderer-side consequences of a settled transform write.
 *
 * Transform history uses the same boundary as the legacy settle helper, but
 * commits through the Worker transaction before invoking this projection.
 * Keeping the projection here ensures the defensive pre-slice synchronizer
 * and history-backed edits invalidate derived output identically.
 */
export function applySettledTransformSyncResult(result: TransformSyncResult, runtime: SliceCancellationRuntime): void {
  if (!result.ok) return;
  invalidateAffectedPlateResults(runtime, result.plateSession.affectedPlateIds);
  applyPlateSessionTransforms(result.plateSession, glVolumeCollection.volumes);
  const slicer = useSlicerStore.getState();
  if (result.plateSession.affectedPlateIds.length > 0 && (slicer.status !== 'slicing' || !slicer.activeSliceTarget)) {
    slicer.setStatus('idle');
    slicer.setResultExported(false);
    slicer.setError(null);
    slicer.resetPreviewState();
    slicer.setProgress(0);
  }
  const previousPlateSession = usePlateSessionStore.getState().snapshot;
  usePlateSessionStore.getState().setSnapshot(result.plateSession);
  if (result.plateSession.affectedPlateIds.length > 0)
    applyPlateResultMutation(result.plateSession, previousPlateSession);
}

// Legacy settle synchronization is retained for the defensive pre-slice
// consistency check. User-facing transforms use TransformHistoryCoordinator,
// which performs the one final write inside its Worker transaction.
let pendingSettledTransformSync: Promise<{ ok: boolean; error?: string }> = Promise.resolve({ ok: true });

/** Queue a snapshot after a move has settled (mouse release or panel commit). */
export function persistSettledModelTransforms(runtime: SlicerRuntime): Promise<TransformSyncResult> {
  const snapshot = [...glVolumeCollection.volumes];
  const sync = pendingSettledTransformSync.then(
    () => syncModelTransforms(runtime, snapshot),
    () => syncModelTransforms(runtime, snapshot),
  );
  const settled = sync.then((result) => {
    // A settled model transform is a slice-input change (spec §8): the
    // bridge invalidated the completed Print, so mirror that in the
    // renderer — the stale toolpath preview is cleared (useSliceResult)
    // and export is disabled until re-slicing. On sync failure nothing
    // was applied, so the prior result stays valid.
    applySettledTransformSyncResult(result, runtime);
    return result;
  }).catch((error) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : String(error),
  }));
  pendingSettledTransformSync = settled;
  return settled;
}

/** Wait for any synchronization triggered by a just-finished edit. */
export function waitForSettledModelTransforms(): Promise<{ ok: boolean; error?: string }> {
  return pendingSettledTransformSync;
}
