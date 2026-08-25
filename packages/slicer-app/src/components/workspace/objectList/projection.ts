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

/** The ObjectList row kind that last drove a selection, used to pick the row
 *  level a fully-selected object is highlighted at (object row vs. its Instances
 *  group list). */
export type HighlightLevel = 'object' | 'instances' | 'instance' | 'part';

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
  levelByObject?: Readonly<Record<number, HighlightLevel>>,
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

  // Most-relative level highlight, resolved PER OBJECT so that a full object and
  // a full instance (both Instance-mode) may be mixed: each touched object is
  // highlighted at its own most-relative level.
  //   full object (all its volumes x instances) -> object row;
  //   full instance(s) of a not-fully-selected object -> instance row(s);
  //   a partial set of one instance -> the selected volume row(s).
  for (const obj of structure) {
    const objSel = objSelected.get(obj.index) ?? 0;
    if (objSel === 0) continue;
    if (objSel === objTotal.get(obj.index)) {
      // A fully-selected object, selected via its Instances group, is highlighted
      // at the instance level (the group represents all instances). Otherwise the
      // object row is the most-relative highlight.
      if (levelByObject?.[obj.index] === 'instances' && obj.instances.length > 1) {
        for (const inst of obj.instances)
          instanceIds.add(instIdByIndex.get(`${obj.index}:${inst.index}`)!);
      } else {
        objectIds.add(objIdByIndex.get(obj.index)!);
      }
      continue;
    }

    const fullInstanceIds: number[] = [];
    let anyPartialInstance = false;
    for (const inst of obj.instances) {
      const key = `${obj.index}:${inst.index}`;
      const sel = instSelected.get(key) ?? 0;
      if (sel === 0) continue;
      if (sel === instTotal.get(key)) fullInstanceIds.push(instIdByIndex.get(key)!);
      else anyPartialInstance = true;
    }

    if (anyPartialInstance) {
      // Part selection (one instance, partial): highlight only its selected
      // volumes. A partial instance mixed with a full instance is Orca's Mixed
      // and is never produced by the guard.
      for (const sel of selected) {
        if (sel.objectIdx !== obj.index) continue;
        const key = `${sel.objectIdx}:${sel.instanceIdx}`;
        const selCount = instSelected.get(key) ?? 0;
        const total = instTotal.get(key) ?? selCount;
        if (selCount > 0 && selCount < total) {
          const vid = volIdByIndex.get(`${sel.objectIdx}:${sel.volumeIdx}`);
          if (vid !== undefined) volumeIds.add(vid);
        }
      }
    } else {
      for (const id of fullInstanceIds) instanceIds.add(id);
    }
  }
  return { objectIds, volumeIds, instanceIds };
}
