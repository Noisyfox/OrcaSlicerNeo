import type { MeshBooleanRequest } from '@slicer/client';
import type { GLVolume } from '../../GLVolume';
import { WipeTowerVolume } from '../../WipeTowerVolume';

type GizmoRequest = Extract<MeshBooleanRequest, { entry: 'gizmo' }>;
export type BooleanOperation = GizmoRequest['operation'];
type Target = { objectId: number; instanceId: number };
export interface MeshBooleanState {
  target: Target | null;
  a: number | null;
  b: number | null;
  picking: 'a' | 'b';
  operation: BooleanOperation;
  deleteDifference: boolean;
  deleteIntersection: boolean;
}
const initial = (): MeshBooleanState => ({ target: null, a: null, b: null, picking: 'a',
  operation: 'union', deleteDifference: false, deleteIntersection: false });

export function meshBooleanTarget(selected: readonly GLVolume[], all: readonly GLVolume[]): Target | null {
  const first = selected[0];
  if (!first || selected.some(v => v instanceof WipeTowerVolume ||
      v.buffer.objectId !== first.buffer.objectId || v.buffer.instanceId !== first.buffer.instanceId)) return null;
  const parts = all.filter(v => !(v instanceof WipeTowerVolume) && v.buffer.objectId === first.buffer.objectId &&
    v.buffer.instanceId === first.buffer.instanceId);
  const ids = new Set(selected.map(v => v.id));
  return parts.length > 1 && parts.every(v => ids.has(v.id))
    ? { objectId: first.buffer.objectId, instanceId: first.buffer.instanceId } : null;
}

/** One scene tool session. No geometry RPC is triggered by any setter. */
export class MeshBooleanSession {
  private state = initial();
  private resultId: number | null = null;
  publishing = false;
  constructor(private readonly volumes: () => readonly GLVolume[], private readonly changed: () => void) {}
  getSnapshot = (): MeshBooleanState => this.state;
  private update(change: Partial<MeshBooleanState>): void { this.state = { ...this.state, ...change }; this.changed(); }
  open(target: Target): void { this.resultId = null; this.state = { ...initial(), target }; this.changed(); }
  close(): void { this.resultId = null; this.state = initial(); this.changed(); }
  setOperation(operation: BooleanOperation): void { if (this.publishing) return; this.update({ operation }); }
  setPicking(picking: 'a' | 'b'): void { if (this.publishing) return; this.update({ picking }); }
  setDeleteInput(value: boolean): void { if (this.publishing) return;
    this.update(this.state.operation === 'difference' ? { deleteDifference: value } : { deleteIntersection: value });
  }
  clear(slot: 'a' | 'b'): void { if (this.publishing) return; this.update({ [slot]: null, picking: slot }); }
  volume(id: number | null): GLVolume | undefined {
    const target = this.state.target;
    return target ? this.volumes().find(v => !(v instanceof WipeTowerVolume) && v.buffer.objectId === target.objectId &&
      v.buffer.instanceId === target.instanceId && v.buffer.volumeId === id) : undefined;
  }
  assign(volume: GLVolume): boolean {
    const { target, picking } = this.state;
    if (!target || volume instanceof WipeTowerVolume || volume.buffer.objectId !== target.objectId ||
        volume.buffer.instanceId !== target.instanceId || this.publishing) return false;
    const id = volume.buffer.volumeId;
    const other = picking === 'a' ? 'b' : 'a';
    this.update({ [picking]: id, ...(this.state[other] === id ? { [other]: null } : {}), picking: 'b' });
    return true;
  }
  reconcile(selected: readonly GLVolume[]): boolean {
    if (this.publishing) return true;
    const target = meshBooleanTarget(selected, this.volumes());
    if (target) {
      if (target.objectId !== this.state.target?.objectId) this.open(target);
      else if (target.instanceId !== this.state.target.instanceId) this.update({ target });
    } else if (!this.resultId || selected.length !== 1 || selected[0].buffer.volumeId !== this.resultId ||
        selected[0].buffer.objectId !== this.state.target?.objectId ||
        selected[0].buffer.instanceId !== this.state.target?.instanceId || !this.volume(this.resultId)) return false;
    const { a, b } = this.state;
    const invalidA = a !== null && !this.volume(a), invalidB = b !== null && !this.volume(b);
    if (invalidA || invalidB) this.update({ ...(invalidA ? { a: null } : {}), ...(invalidB ? { b: null } : {}) });
    return this.volumes().filter(v => v.buffer.objectId === this.state.target?.objectId &&
      v.buffer.instanceId === this.state.target?.instanceId && !(v instanceof WipeTowerVolume)).length > 1;
  }
  completed(volumeId: number): void { this.resultId = volumeId; this.update({ a: null, b: null, picking: 'a' }); }
  request(keepPainting: boolean): GizmoRequest | null {
    const { target, a, b, operation, deleteDifference, deleteIntersection } = this.state;
    if (!target || a === null || b === null || a === b || !this.volume(a) || !this.volume(b)) return null;
    return { entry: 'gizmo', ...target, sourceVolumeId: a, toolVolumeId: b, operation,
      deleteInput: operation === 'difference' ? deleteDifference : operation === 'intersection' && deleteIntersection,
      keepPainting };
  }
}
