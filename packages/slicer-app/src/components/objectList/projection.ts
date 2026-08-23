import type { ModelObjectStructure } from '@slicer/client';

/** The set of structure rows (by stable ObjectID) currently selected in the viewport. */
export interface SelectionProjection {
  objectIds: Set<number>;
  volumeIds: Set<number>;
  instanceIds: Set<number>;
}

export const EMPTY_PROJECTION: SelectionProjection = {
  objectIds: new Set(),
  volumeIds: new Set(),
  instanceIds: new Set(),
};

/**
 * Project the viewport's selected GL volumes (index composites) onto the current
 * structure's stable IDs so the ObjectList can highlight the matching rows. The
 * controller remains the source of truth for selection; this is a read-only
 * projection (spec §6).
 */
export function projectSelection(
  structure: ModelObjectStructure[],
  selected: ReadonlyArray<{ objectIdx: number; volumeIdx: number; instanceIdx: number }>,
): SelectionProjection {
  const objectIds = new Set<number>();
  const volumeIds = new Set<number>();
  const instanceIds = new Set<number>();
  for (const sel of selected) {
    const obj = structure[sel.objectIdx];
    if (!obj) continue;
    objectIds.add(obj.id);
    const vol = obj.volumes[sel.volumeIdx];
    if (vol) volumeIds.add(vol.id);
    const inst = obj.instances[sel.instanceIdx];
    if (inst) instanceIds.add(inst.id);
  }
  return { objectIds, volumeIds, instanceIds };
}
