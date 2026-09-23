import type { FilamentMutationSummary, PlateSessionMutation, PlateSessionSnapshot, SlicerClient } from '@slicer/client';
import { useSlicerStore } from './useSlicerStore';

export type SliceCancellationRuntime = Pick<SlicerClient, 'cancel'> &
  Partial<Pick<SlicerClient, 'getRuntimeExecutionState'>>;

/** Invalidate exactly the native receipt's affected plates and, for a
 * threaded runtime, begin cancellation without making the mutation await the
 * worker's terminal response.  Serial admission rejects the mutation before
 * this path can run; the explicit guard also keeps a stale receipt from
 * cancelling a serial slice. */
export function invalidateAffectedPlateResults(
  runtime: SliceCancellationRuntime | undefined,
  affectedPlateIds: readonly string[],
): void {
  const plateIds = [...new Set(affectedPlateIds)];
  if (plateIds.length === 0) return;
  const store = useSlicerStore.getState();
  const active = store.activeSliceTarget;
  store.invalidatePlateResults(plateIds);
  const threaded = runtime?.getRuntimeExecutionState?.().threaded;
  if (active && plateIds.includes(active.plateId) && runtime?.cancel && threaded !== false)
    void runtime.cancel().catch(() => undefined);
}

/** Apply the result ownership rules for one authoritative plate transaction. */
export function applyPlateResultMutation(
  mutation: PlateSessionMutation,
  previous: PlateSessionSnapshot | null = null,
): void {
  const store = useSlicerStore.getState();
  const structural = mutation.dirtyReasons?.includes('plate-structure') ?? false;
  if (structural && previous) {
    const next = new Set(mutation.plates.map((plate) => plate.plateId));
    for (const plate of previous.plates) if (!next.has(plate.plateId)) store.discardPlateResult(plate.plateId);
  } else if (mutation.affectedPlateIds?.length) {
    store.invalidatePlateResults(mutation.affectedPlateIds);
  }
  const revision = mutation.inputRevisions?.[mutation.currentPlateId];
  if (typeof revision === 'number' && Number.isSafeInteger(revision)) store.activatePlateResult(mutation.currentPlateId, revision);
}

/**
 * Apply the result ownership rules for a committed filament transaction.
 *
 * Filament slot/routing mutations already carry their authoritative affected
 * plate set from the Worker.  The app must consume that set instead of
 * invalidating whichever plate happens to be selected.  Shared rack edits
 * intentionally omit the list in older bridge envelopes, so the cached and
 * active targets form the conservative complete set in that case.
 */
export async function applyFilamentMutationResult(
  mutation: FilamentMutationSummary,
  runtime?: SliceCancellationRuntime,
): Promise<void> {
  const store = useSlicerStore.getState();
  const affected = new Set(mutation.affectedPlateIds ?? []);
  if (mutation.allPlateResultsInvalidated) {
    for (const plateId of Object.keys(store.plateResults)) affected.add(plateId);
    if (store.sliceTarget) affected.add(store.sliceTarget.plateId);
    if (store.activeSliceTarget) affected.add(store.activeSliceTarget.plateId);
  }
  const plateIds = [...affected];
  if (plateIds.length === 0) return;
  invalidateAffectedPlateResults(runtime, plateIds);
}
