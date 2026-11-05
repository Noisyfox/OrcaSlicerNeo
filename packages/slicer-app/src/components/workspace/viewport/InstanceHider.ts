export interface InstanceHiderTarget {
  readonly objectId: number;
  readonly instanceId: number;
}

interface InstanceVolume { readonly buffer: InstanceHiderTarget }

/** Shared projection for ordinary meshes, viewport picks and painting sources. */
export function visibleInstanceVolumes<T extends InstanceVolume>(volumes: readonly T[], target: InstanceHiderTarget | null): readonly T[] {
  return target ? volumes.filter(volume => matchesInstance(volume, target)) : volumes;
}

function matchesInstance(volume: InstanceVolume, target: InstanceHiderTarget): boolean {
  return volume.buffer.objectId === target.objectId && volume.buffer.instanceId === target.instanceId;
}

export interface InstanceHiderLease {
  update(target: InstanceHiderTarget): void;
  release(): void;
}

/** Orca's opt-in InstancesHider lifetime, shared by Prepare tools. It owns no
 * geometry or selection. A replaced tool cannot release its successor's scope. */
export class InstanceHider {
  private target: InstanceHiderTarget | null = null;
  private owner: object | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): InstanceHiderTarget | null => this.target;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  isVisible(volume: InstanceVolume): boolean {
    return this.target === null || matchesInstance(volume, this.target);
  }

  acquire(target: InstanceHiderTarget): InstanceHiderLease {
    const owner = {};
    this.owner = owner;
    this.publish(target);
    return {
      update: next => { if (this.owner === owner) this.publish(next); },
      release: () => {
        if (this.owner !== owner) return;
        this.owner = null;
        this.publish(null);
      },
    };
  }

  private publish(target: InstanceHiderTarget | null): void {
    if (this.target?.objectId === target?.objectId && this.target?.instanceId === target?.instanceId) return;
    this.target = target ? { objectId: target.objectId, instanceId: target.instanceId } : null;
    for (const listener of this.listeners) listener();
  }
}
