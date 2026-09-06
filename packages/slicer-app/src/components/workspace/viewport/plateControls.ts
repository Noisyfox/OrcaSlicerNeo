import type { PlateSessionSnapshot } from '@slicer/client';

export const MAX_PLATE_COUNT = 36;

/** Availability is a projection of the authoritative session only. */
export function canAddPlate(snapshot: PlateSessionSnapshot | null): boolean {
  return snapshot !== null && snapshot.plates.length < MAX_PLATE_COUNT;
}
export function canDeletePlate(snapshot: PlateSessionSnapshot | null): boolean {
  return snapshot !== null && snapshot.plates.length > 1;
}
