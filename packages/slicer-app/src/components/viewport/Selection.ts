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

export interface SelectableVolume {
  readonly id: VolumeId;
  readonly buffer: {
    readonly objectIdx: number;
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

  /** Replace selection with the complete instance that contains `hit`. */
  replaceFromHit(hit: SelectableVolume, collection: readonly SelectableVolume[]): boolean {
    return this.replace(this.volumesForInstance(hit, collection));
  }

  /**
   * Toggle the complete instance that contains `hit`. A partially stale
   * selection is treated as unselected and restored as a complete instance.
   */
  toggleFromHit(hit: SelectableVolume, collection: readonly SelectableVolume[]): boolean {
    const instance = this.volumesForInstance(hit, collection);
    const allSelected = instance.length > 0 && instance.every((volume) => this.selectedIds.has(volume.id));
    if (allSelected) {
      let changed = false;
      for (const volume of instance) changed = this.selectedIds.delete(volume.id) || changed;
      return changed;
    }

    let changed = false;
    for (const volume of instance) {
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
    const next = new Set(volumes.map((volume) => volume.id));
    if (next.size === this.selectedIds.size && [...next].every((id) => this.selectedIds.has(id))) {
      return false;
    }
    this.selectedIds = next;
    return true;
  }

  private volumesForInstance<T extends SelectableVolume>(hit: T, collection: readonly T[]): T[] {
    const key = instanceKeyOf(hit);
    return collection.filter((volume) => instanceKeyOf(volume) === key);
  }
}
