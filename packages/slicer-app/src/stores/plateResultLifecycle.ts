import type { FilamentMutationSummary, PlateSessionMutation, PlateSessionSnapshot, SlicerClient } from '@slicer/client';
import { useSlicerStore } from './useSlicerStore';

export type SliceCancellationRuntime = Pick<SlicerClient, 'cancel'> &
  Partial<Pick<SlicerClient, 'getRuntimeExecutionState'>>;

/** Invalidate the native receipt's affected plates and, for a threaded
 * runtime, begin cancellation without making the mutation await the Worker's
 * terminal response.  Serial admission rejects the mutation before this path
 * can run; the explicit guard also keeps a stale receipt from cancelling a
 * serial slice. */
export function invalidateAffectedPlateResults(
  runtime: SliceCancellationRuntime | undefined,
  affectedPlateIds: readonly string[],
): void {
  const plateIds = [...new Set(affectedPlateIds)];
  const store = useSlicerStore.getState();
  const active = store.activeSliceTarget;
  if (plateIds.length === 0) return;
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
 * Every filament mutation carries its authoritative affected plate set from
 * the Worker.  Shared rack edits list every live plate; object and part edits
 * list only their membership.  The app never infers an invalidation scope from
 * cached UI state.
 */
export async function applyFilamentMutationResult(
  mutation: FilamentMutationSummary,
  runtime?: SliceCancellationRuntime,
): Promise<void> {
  invalidateAffectedPlateResults(runtime, mutation.affectedPlateIds);
}
