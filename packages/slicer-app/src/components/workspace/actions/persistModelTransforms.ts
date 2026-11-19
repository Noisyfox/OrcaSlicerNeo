import type { TransformGestureResult } from './transformHistory';
import { glVolumeCollection } from '../viewport/GLVolume';
import { activatePlateResultForSession, invalidateAffectedPlateResults, type SliceCancellationRuntime } from '@/stores/plateResultLifecycle';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { applyPlateSessionTransforms, type TransformSyncResult } from './syncModelTransforms';

/** Apply the renderer-side consequences of a settled transform write.
 *
 * Transform history commits through the Worker transaction before invoking this projection.
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
  usePlateSessionStore.getState().setSnapshot(result.plateSession);
  if (result.plateSession.affectedPlateIds.length > 0)
    activatePlateResultForSession(result.plateSession);
}

const released = new Set<Promise<TransformGestureResult>>();

/** Register at release, before the asynchronous reservation can enter the project FIFO. */
export function trackReleasedTransform(completion: Promise<TransformGestureResult>): void {
  released.add(completion);
  void completion.then(() => released.delete(completion));
}

type Settlement = { ok: true } | { ok: false; error: string };

/** Snapshot releases at command admission. Live gestures and later edits remain independent. */
export function waitForSettledModelTransforms(): Promise<Settlement> | null {
  if (released.size === 0) return null;
  return Promise.all(released).then(results => {
    for (const result of results) {
      if (result.outcome === 'failed' || result.outcome === 'stale')
        return { ok: false, error: result.error };
    }
    return { ok: true };
  });
}
