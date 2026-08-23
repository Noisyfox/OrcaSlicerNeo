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
  kind: 'object' | 'part' | 'instance';
  /** The GLVolume ID strings (`objectIdx:volumeIdx:instanceIdx`) this row selects.
   *  Part rows use instance 0; the caller re-anchors them with the selection's
   *  single instance (Orca anchors a part to one instance). */
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
    rows.push({ key: `obj:${oi}`, kind: 'object', volumeIds: objectIds, target: { objectIdx: oi } });
    if (volCount > 1) {
      for (let vi = 0; vi < volCount; vi++)
        rows.push({
          key: `vol:${oi}:${vi}`,
          kind: 'part',
          // Instance 0 as the static fallback; the caller re-anchors to the
          // current selection's single instance.
          volumeIds: [`${oi}:${vi}:0`],
          target: { objectIdx: oi, volumeIdx: vi },
        });
    }
    if (instCount > 1) {
      for (let ii = 0; ii < instCount; ii++)
        rows.push({
          key: `inst:${oi}:${ii}`,
          kind: 'instance',
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
  if (selected.length === 0) return { objectIds, volumeIds, instanceIds };

  const objIdByIndex = new Map<number, number>();
  const volIdByIndex = new Map<string, number>();
  const instIdByIndex = new Map<string, number>();
  const objTotal = new Map<number, number>();
  const objSelected = new Map<number, number>();
  const instTotal = new Map<string, number>();
  const instSelected = new Map<string, number>();
  for (const obj of structure) {
    objIdByIndex.set(obj.index, obj.id);
    obj.volumes.forEach((vol, vi) => volIdByIndex.set(`${obj.index}:${vi}`, vol.id));
    obj.instances.forEach((inst, ii) => instIdByIndex.set(`${obj.index}:${ii}`, inst.id));
    objTotal.set(obj.index, obj.volumes.length * obj.instances.length);
    objSelected.set(obj.index, selected.filter((s) => s.objectIdx === obj.index).length);
    for (const inst of obj.instances) {
      const key = `${obj.index}:${inst.index}`;
      instTotal.set(key, obj.volumes.length);
      instSelected.set(key, selected.filter((s) => s.objectIdx === obj.index && s.instanceIdx === inst.index).length);
    }
  }

  // Most-relative level highlight: if whole objects are selected and nothing is
  // partial, highlight the object rows; else whole instances -> instance rows;
  // else only the selected volumes of a partially-selected instance.
  const touchedObjects = [...objSelected.entries()].filter(([, sel]) => sel > 0);
  const allObjectsFull = touchedObjects.length > 0 && touchedObjects.every(([idx, sel]) => sel === objTotal.get(idx));
  const anyPartialInstance = [...instSelected.entries()].some(([key, sel]) => sel > 0 && sel < (instTotal.get(key) ?? sel));

  if (allObjectsFull && !anyPartialInstance) {
    for (const [idx] of touchedObjects) objectIds.add(objIdByIndex.get(idx)!);
    return { objectIds, volumeIds, instanceIds };
  }
  const touchedInstances = [...instSelected.entries()].filter(([, sel]) => sel > 0);
  if (touchedInstances.length > 0 && touchedInstances.every(([key, sel]) => sel === (instTotal.get(key) ?? sel))) {
    for (const [key] of touchedInstances) instanceIds.add(instIdByIndex.get(key)!);
    return { objectIds, volumeIds, instanceIds };
  }
  // Partial instance(s): highlight the selected volumes of those partial instances.
  for (const sel of selected) {
    const key = `${sel.objectIdx}:${sel.instanceIdx}`;
    const selCount = instSelected.get(key) ?? 0;
    const total = instTotal.get(key) ?? 0;
    if (selCount > 0 && selCount < total) {
      const vid = volIdByIndex.get(`${sel.objectIdx}:${sel.volumeIdx}`);
      if (vid !== undefined) volumeIds.add(vid);
    }
  }
  return { objectIds, volumeIds, instanceIds };
}
