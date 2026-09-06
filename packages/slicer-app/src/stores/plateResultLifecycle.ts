import type { PlateSessionMutation, PlateSessionSnapshot } from '@slicer/client';
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
