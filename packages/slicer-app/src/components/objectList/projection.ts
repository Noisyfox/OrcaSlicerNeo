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

/** A selectable ObjectList row in tree reading order (object, then parts, then instances). */
export interface SelectableRow {
  key: string;
  /** The GLVolume ID strings (`objectIdx:volumeIdx:instanceIdx`) this row selects. */
  volumeIds: string[];
  target: { objectIdx: number; volumeIdx?: number; instanceIdx?: number };
}

/** Build the flat list of selectable rows (pre-order): object, then its part rows
 *  (only when multi-volume), then its instance rows (only when multi-instance). */
export function buildSelectableRows(structure: ModelObjectStructure[]): SelectableRow[] {
  const rows: SelectableRow[] = [];
  structure.forEach((obj, oi) => {
    const volCount = obj.volumes.length;
    const instCount = obj.instances.length;
    const objectIds: string[] = [];
    for (let vi = 0; vi < volCount; vi++)
      for (let ii = 0; ii < instCount; ii++) objectIds.push(`${oi}:${vi}:${ii}`);
    rows.push({ key: `obj:${oi}`, volumeIds: objectIds, target: { objectIdx: oi } });
    if (volCount > 1) {
      for (let vi = 0; vi < volCount; vi++)
        rows.push({
          key: `vol:${oi}:${vi}`,
          volumeIds: Array.from({ length: instCount }, (_, ii) => `${oi}:${vi}:${ii}`),
          target: { objectIdx: oi, volumeIdx: vi },
        });
    }
    if (instCount > 1) {
      for (let ii = 0; ii < instCount; ii++)
        rows.push({
          key: `inst:${oi}:${ii}`,
          volumeIds: Array.from({ length: volCount }, (_, vi) => `${oi}:${vi}:${ii}`),
          target: { objectIdx: oi, instanceIdx: ii },
        });
    }
  });
  return rows;
}

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
