import type { SlicerRuntime } from '../../platform';
import { glVolumeCollection } from '../viewport/GLVolume';
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
  pendingSettledTransformSync = sync.catch((error) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  return pendingSettledTransformSync;
}

/** Wait for any synchronization triggered by a just-finished edit. */
export function waitForSettledModelTransforms(): Promise<SyncResult> {
  return pendingSettledTransformSync;
}
