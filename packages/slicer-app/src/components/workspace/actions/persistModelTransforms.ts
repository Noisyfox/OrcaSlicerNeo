import type { SlicerRuntime } from '@orca/platform-contract';
import { glVolumeCollection } from '../viewport/GLVolume';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import { syncModelTransforms } from './syncModelTransforms';

type SyncResult = { ok: boolean; error?: string };

// Mouse and numeric move commits deliberately serialize. This preserves the
// exact state at each settled edit and lets Add Model wait for an in-flight
// release commit instead of performing a late, second synchronization.
let pendingSettledTransformSync: Promise<SyncResult> = Promise.resolve({ ok: true });

/** Queue a snapshot after a move has settled (mouse release or panel commit). */
export function persistSettledModelTransforms(runtime: SlicerRuntime): Promise<SyncResult> {
  const snapshot = [...glVolumeCollection.volumes];
  const sync = pendingSettledTransformSync.then(
    () => syncModelTransforms(runtime, snapshot),
    () => syncModelTransforms(runtime, snapshot),
  );
  pendingSettledTransformSync = sync.then((result) => {
    // A settled model transform is a slice-input change (spec §8): the
    // bridge invalidated the completed Print, so mirror that in the
    // renderer — the stale toolpath preview is cleared (useSliceResult)
    // and export is disabled until re-slicing. On sync failure nothing
    // was applied, so the prior result stays valid.
    if (result.ok) {
      const slicer = useSlicerStore.getState();
      slicer.setStatus('idle');
      slicer.setResultExported(false);
      slicer.setError(null);
      slicer.setLayers(0);
      slicer.setProgress(0);
      useProjectStore.getState().markDirty();
    }
    return result;
  });
  pendingSettledTransformSync = pendingSettledTransformSync.catch((error) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  return pendingSettledTransformSync;
}

/** Wait for any synchronization triggered by a just-finished edit. */
export function waitForSettledModelTransforms(): Promise<SyncResult> {
  return pendingSettledTransformSync;
}
