/**
 * Renderer-only, scene-owned selection of composite GL volumes.
 *
 * The default interaction mode is deliberately instance based: a hit on one
 * render copy selects every volume belonging to its `(objectIdx, instanceIdx)`.
 * That mirrors OrcaSlicer's native GLCanvas3D selection mode and guarantees
 * that a later instance-transform edit never leaves sibling render copies out
 * of sync.
 */
export type VolumeId = string;

export type InstanceKey = `${number}:${number}`;

/** How a canvas hit expands the selection (native GLCanvas3D selection modes). */
export type SelectionMode = 'object' | 'volume' | 'instance';

export interface SelectableVolume {
  readonly id: VolumeId;
  readonly buffer: {
    readonly objectIdx: number;
    readonly volumeIdx: number;
    readonly instanceIdx: number;
  };
}

export function instanceKeyOf(volume: Pick<SelectableVolume, 'buffer'>): InstanceKey {
  return `${volume.buffer.objectIdx}:${volume.buffer.instanceIdx}`;
}

export class Selection {
  private selectedIds = new Set<VolumeId>();

  /** A read-only view that preserves selection insertion order. */
  get ids(): ReadonlySet<VolumeId> {
    return this.selectedIds;
  }

  get size(): number {
    return this.selectedIds.size;
  }

  get empty(): boolean {
    return this.selectedIds.size === 0;
  }

  has(volume: Pick<SelectableVolume, 'id'>): boolean {
    return this.selectedIds.has(volume.id);
  }

  /** Replace selection with the `mode`-expanded group that contains `hit`. */
  replaceFromHit(hit: SelectableVolume, collection: readonly SelectableVolume[], mode: SelectionMode = 'instance'): boolean {
    return this.replace(this.volumesForMode(hit, collection, mode));
  }

  /** Replace the selection with exactly these volume IDs (box-select result). */
  replaceIds(ids: readonly string[]): boolean {
    const next = new Set(ids);
    if (next.size === this.selectedIds.size && [...next].every((id) => this.selectedIds.has(id))) {
      return false;
    }
    this.selectedIds = next;
    return true;
  }

  /** Union volume IDs into the selection (additive box select). */
  addIds(ids: readonly string[]): boolean {
    let changed = false;
    for (const id of ids) {
      if (!this.selectedIds.has(id)) {
        this.selectedIds.add(id);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Toggle the `mode`-expanded group that contains `hit`. A partially stale
   * selection is treated as unselected and restored as a complete group.
   */
  toggleFromHit(hit: SelectableVolume, collection: readonly SelectableVolume[], mode: SelectionMode = 'instance'): boolean {
    const group = this.volumesForMode(hit, collection, mode);
    const allSelected = group.length > 0 && group.every((volume) => this.selectedIds.has(volume.id));
    if (allSelected) {
      let changed = false;
      for (const volume of group) changed = this.selectedIds.delete(volume.id) || changed;
      return changed;
    }

    let changed = false;
    for (const volume of group) {
      if (!this.selectedIds.has(volume.id)) {
        this.selectedIds.add(volume.id);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Replace the selection with the volumes matching a composite target
   * (object list row click). The presence of volumeIdx/instanceIdx selects the
   * expansion width: object only -> object; object+volume -> that volume;
   * object+instance -> that instance.
   */
  replaceComposite(collection: readonly SelectableVolume[], target: { objectIdx: number; volumeIdx?: number; instanceIdx?: number }): boolean {
    return this.replace(this.volumesForTarget(collection, target));
  }

  /** Toggle the volumes matching a composite target (Ctrl/Cmd additive in lists). */
  toggleComposite(collection: readonly SelectableVolume[], target: { objectIdx: number; volumeIdx?: number; instanceIdx?: number }): boolean {
    const group = this.volumesForTarget(collection, target);
    const allSelected = group.length > 0 && group.every((volume) => this.selectedIds.has(volume.id));
    if (allSelected) {
      let changed = false;
      for (const volume of group) changed = this.selectedIds.delete(volume.id) || changed;
      return changed;
    }
    let changed = false;
    for (const volume of group) {
      if (!this.selectedIds.has(volume.id)) {
        this.selectedIds.add(volume.id);
        changed = true;
      }
    }
    return changed;
  }

  clear(): boolean {
    if (this.selectedIds.size === 0) return false;
    this.selectedIds.clear();
    return true;
  }

  /** Remove IDs whose volumes no longer belong to the current scene. */
  prune(collection: readonly Pick<SelectableVolume, 'id'>[]): boolean {
    const existing = new Set(collection.map((volume) => volume.id));
    let changed = false;
    for (const id of this.selectedIds) {
      if (!existing.has(id)) {
        this.selectedIds.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  volumes<T extends SelectableVolume>(collection: readonly T[]): T[] {
    return collection.filter((volume) => this.selectedIds.has(volume.id));
  }

  instanceKeys<T extends SelectableVolume>(collection: readonly T[]): Set<InstanceKey> {
    return new Set(this.volumes(collection).map(instanceKeyOf));
  }

  private replace(volumes: readonly Pick<SelectableVolume, 'id'>[]): boolean {
    return this.replaceIds(volumes.map((volume) => volume.id));
  }

  private volumesForMode<T extends SelectableVolume>(hit: T, collection: readonly T[], mode: SelectionMode): T[] {
    if (mode === 'object') return collection.filter((v) => v.buffer.objectIdx === hit.buffer.objectIdx);
    if (mode === 'volume') return collection.filter(
      (v) => v.buffer.objectIdx === hit.buffer.objectIdx && v.buffer.volumeIdx === hit.buffer.volumeIdx,
    );
    const key = instanceKeyOf(hit);
    return collection.filter((v) => instanceKeyOf(v) === key);
  }

  private volumesForTarget<T extends SelectableVolume>(collection: readonly T[], target: { objectIdx: number; volumeIdx?: number; instanceIdx?: number }): T[] {
    if (target.instanceIdx !== undefined) {
      return collection.filter((v) => v.buffer.objectIdx === target.objectIdx && v.buffer.instanceIdx === target.instanceIdx);
    }
    if (target.volumeIdx !== undefined) {
      return collection.filter((v) => v.buffer.objectIdx === target.objectIdx && v.buffer.volumeIdx === target.volumeIdx);
    }
    return collection.filter((v) => v.buffer.objectIdx === target.objectIdx);
  }
}
