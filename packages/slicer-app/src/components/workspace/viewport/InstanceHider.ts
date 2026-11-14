export interface InstanceHiderTarget {
  readonly objectId: number;
  readonly instanceId: number;
}

export interface IsolatedVolumeTarget extends InstanceHiderTarget {
  readonly volumeId: number;
}

/** A multi-volume scope keeps towers visible while restricting model volumes. */
export interface IsolatedVolumeScope {
  readonly kind: 'volumes';
  readonly volumes: readonly IsolatedVolumeTarget[];
}

export type InstanceHiderScope = InstanceHiderTarget | IsolatedVolumeScope;

interface InstanceVolume { readonly buffer: InstanceHiderTarget & { readonly volumeId: number } }

function volumeKey(target: IsolatedVolumeTarget): string {
  return `${target.objectId}:${target.instanceId}:${target.volumeId}`;
}

function isVolumeScope(scope: InstanceHiderScope): scope is IsolatedVolumeScope {
  return 'kind' in scope && scope.kind === 'volumes';
}

/** Shared projection for ordinary meshes, viewport picks and painting sources. */
export function visibleToolVolumes<T extends InstanceVolume>(volumes: readonly T[], scope: InstanceHiderScope | null): readonly T[] {
  if (scope === null) return volumes;
  if (!isVolumeScope(scope)) return volumes.filter(volume => matchesInstance(volume, scope));
  const keys = new Set(scope.volumes.map(volumeKey));
  return volumes.filter(volume => keys.has(volumeKey(volume.buffer)));
}

function matchesInstance(volume: InstanceVolume, target: InstanceHiderTarget): boolean {
  return volume.buffer.objectId === target.objectId && volume.buffer.instanceId === target.instanceId;
}

export function hidesWipeTowers(scope: InstanceHiderScope | null): boolean {
  return scope !== null && !isVolumeScope(scope);
}

export interface InstanceHiderLease {
  update(scope: InstanceHiderScope): void;
  release(): void;
}

/** Orca's opt-in isolation lifetime, shared by Prepare tools. It owns no
 * geometry or selection. A replaced tool cannot release its successor's scope. */
export class InstanceHider {
  private scope: InstanceHiderScope | null = null;
  private volumeKeys: ReadonlySet<string> | null = null;
  private owner: object | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): InstanceHiderScope | null => this.scope;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  isVisible(volume: InstanceVolume): boolean {
    const scope = this.scope;
    if (scope === null) return true;
    if (!isVolumeScope(scope)) return matchesInstance(volume, scope);
    return this.volumeKeys!.has(volumeKey(volume.buffer));
  }

  acquire(scope: InstanceHiderScope): InstanceHiderLease {
    const owner = {};
    this.owner = owner;
    this.publish(scope);
    return {
      update: next => { if (this.owner === owner) this.publish(next); },
      release: () => {
        if (this.owner !== owner) return;
        this.owner = null;
        this.publish(null);
      },
    };
  }

  private publish(next: InstanceHiderScope | null): void {
    const scope = copyScope(next);
    if (sameScope(this.scope, scope)) return;
    this.scope = scope;
    this.volumeKeys = scope !== null && isVolumeScope(scope) ? new Set(scope.volumes.map(volumeKey)) : null;
    for (const listener of this.listeners) listener();
  }
}

function copyScope(scope: InstanceHiderScope | null): InstanceHiderScope | null {
  if (scope === null) return null;
  if (!isVolumeScope(scope)) return { objectId: scope.objectId, instanceId: scope.instanceId };
  const unique = new Map(scope.volumes.map(target => [volumeKey(target), {
    objectId: target.objectId, instanceId: target.instanceId, volumeId: target.volumeId,
  }]));
  const volumes = [...unique.values()].sort((a, b) =>
    a.objectId - b.objectId || a.instanceId - b.instanceId || a.volumeId - b.volumeId);
  return { kind: 'volumes', volumes };
}

function sameScope(a: InstanceHiderScope | null, b: InstanceHiderScope | null): boolean {
  if (a === null || b === null) return a === b;
  if (isVolumeScope(a)) {
    return isVolumeScope(b) && a.volumes.length === b.volumes.length &&
      a.volumes.every((target, i) => volumeKey(target) === volumeKey(b.volumes[i]));
  }
  return !isVolumeScope(b) && a.objectId === b.objectId && a.instanceId === b.instanceId;
}
