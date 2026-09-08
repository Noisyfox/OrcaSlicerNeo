import type { FilamentMutationSummary, PlateSessionMutation, PlateSessionSnapshot, SlicerClient } from '@slicer/client';
import { useSlicerStore } from './useSlicerStore';

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
  runtime?: Pick<SlicerClient, 'cancel'>,
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
  const active = store.activeSliceTarget;
  store.invalidatePlateResults(plateIds);
  if (active && affected.has(active.plateId) && runtime?.cancel) {
    await runtime.cancel().catch(() => undefined);
  }
}
