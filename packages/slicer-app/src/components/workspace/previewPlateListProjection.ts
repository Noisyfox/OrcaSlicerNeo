import type { PlateSessionPlate, PlateSessionSnapshot } from '@slicer/client';
import type { PlateSliceResult } from '../../stores/useSlicerStore';

export type PreviewPlateStatus = 'sliced' | 'unsliced' | 'empty' | 'out-of-bounds';

export interface PreviewPlateListItem {
  plate: PlateSessionPlate;
  current: boolean;
  status: PreviewPlateStatus;
  label: string;
  detail: string;
}

function hasMembers(snapshot: PlateSessionSnapshot, plate: PlateSessionPlate): boolean {
  if (plate.instanceIds) return plate.instanceIds.length > 0;
  if (snapshot.instances) return snapshot.instances.some((instance) => instance.member && instance.plateId === plate.plateId);
  return true;
}

export function projectPreviewPlateList(
  snapshot: PlateSessionSnapshot | null | undefined,
  results: Readonly<Record<string, PlateSliceResult>> = {},
): PreviewPlateListItem[] {
  if (!snapshot) return [];
  return snapshot.plates
    .slice()
    .sort((a, b) => a.displayIndex - b.displayIndex)
    .map((plate) => {
      const current = plate.plateId === snapshot.currentPlateId;
      const outOfBounds = plate.valid === false || Boolean(plate.outOfBoundsInstanceIds?.length);
      const empty = !hasMembers(snapshot, plate);
      const revision = snapshot.inputRevisions?.[plate.plateId];
      const result = results[plate.plateId];
      const sliced = !outOfBounds && !empty && result !== undefined &&
        (revision === undefined || result.target.inputRevision === revision);
      const status: PreviewPlateStatus = outOfBounds
        ? 'out-of-bounds'
        : empty
          ? 'empty'
          : sliced ? 'sliced' : 'unsliced';
      const detail = status === 'out-of-bounds'
        ? 'Out of bounds'
        : status === 'empty'
          ? 'Empty'
          : status === 'sliced' ? 'Sliced' : 'Unsliced';
      return { plate, current, status, label: plate.name || `Plate ${plate.displayIndex + 1}`, detail };
    });
}
