import type {
  PrimeTowerMoveRequest,
  PrimeTowerMoveResultOrError,
  PrimeTowerProjection,
} from '@slicer/client';
import type { PrimeTowerPlateProjection } from '@slicer/client';
import { useEffect, useState } from 'react';
import { clampPrimeTowerPosition, type PrimeTowerPosition } from './primeTowerGeometry';

export type PrimeTowerPointerOwner = 'none' | 'body' | 'gizmo';

export function usePrimeTowerInteractionVersion(controller: PrimeTowerInteractionController | undefined): number {
  const [version, setVersion] = useState(0);
  useEffect(() => controller?.subscribe(() => setVersion((value) => value + 1)), [controller]);
  return version;
}

export interface PrimeTowerMovePort {
  move(request: PrimeTowerMoveRequest): Promise<PrimeTowerMoveResultOrError>;
  reconcile(): Promise<void>;
  revision(plateId: string): number;
}

/**
 * Owns only the special Prepare-scene tower selection and gesture. Model
 * selection/history remains in SceneInteractionController. Pointer movement
 * is deliberately renderer-local; the port is called once, only after a
 * changed gesture is released.
 */
export class PrimeTowerInteractionController {
  private readonly listeners = new Set<() => void>();
  private projectionState: PrimeTowerProjection | null = null;
  private selectedPlateIdState: string | null = null;
  private gizmoArmedState = false;
  private pointerOwnerState: PrimeTowerPointerOwner = 'none';
  private startWorld: { x: number; y: number } | null = null;
  private startPosition: PrimeTowerPosition | null = null;
  private transientPositionState: PrimeTowerPosition | null = null;
  private commitInFlight = false;
  private moveCommandCountState = 0;

  constructor(private readonly port: PrimeTowerMovePort) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get projection(): PrimeTowerProjection | null { return this.projectionState; }
  get selectedPlateId(): string | null { return this.selectedPlateIdState; }
  get gizmoArmed(): boolean { return this.gizmoArmedState; }
  get owner(): PrimeTowerPointerOwner { return this.pointerOwnerState; }
  get transientPosition(): PrimeTowerPosition | null { return this.transientPositionState; }
  get moveCommandCount(): number { return this.moveCommandCountState; }

  setProjection(projection: PrimeTowerProjection | null): void {
    this.projectionState = projection;
    const selected = this.selectedPlateIdState;
    const selectedProjection = selected ? projection?.plates.find((plate) => plate.plateId === selected) : undefined;
    if (!selectedProjection || !selectedProjection.eligible || selected !== projection?.currentPlateId) {
      this.clearSelection(false);
    } else if (this.pointerOwnerState === 'none') {
      this.transientPositionState = { ...selectedProjection.position };
    }
    this.emit();
  }

  select(plateId: string): boolean {
    if (this.pointerOwnerState !== 'none' || this.commitInFlight) return false;
    const plate = this.plate(plateId);
    if (!plate?.eligible || plateId !== this.projectionState?.currentPlateId) return false;
    if (this.selectedPlateIdState !== plateId) this.gizmoArmedState = false;
    this.selectedPlateIdState = plateId;
    this.transientPositionState = { ...plate.position };
    this.emit();
    return true;
  }

  clearSelection(emit = true): boolean {
    const changed = this.selectedPlateIdState !== null || this.gizmoArmedState || this.pointerOwnerState !== 'none';
    this.selectedPlateIdState = null;
    this.gizmoArmedState = false;
    this.pointerOwnerState = 'none';
    this.startWorld = null;
    this.startPosition = null;
    this.transientPositionState = null;
    if (emit && changed) this.emit();
    return changed;
  }

  toggleGizmo(): boolean {
    const plateId = this.selectedPlateIdState;
    const plate = plateId ? this.plate(plateId) : undefined;
    if (!plateId || !plate?.eligible || plateId !== this.projectionState?.currentPlateId
      || this.pointerOwnerState !== 'none' || this.commitInFlight) return false;
    this.gizmoArmedState = !this.gizmoArmedState;
    this.emit();
    return true;
  }

  beginBody(plateId: string, world: { x: number; y: number }): boolean {
    const plate = this.plate(plateId);
    if (!plate?.eligible || plateId !== this.projectionState?.currentPlateId || this.commitInFlight) return false;
    if (this.selectedPlateIdState !== plateId) this.gizmoArmedState = false;
    this.selectedPlateIdState = plateId;
    this.pointerOwnerState = 'body';
    this.startWorld = { ...world };
    this.startPosition = { ...plate.position };
    this.transientPositionState = { ...plate.position };
    this.emit();
    return true;
  }

  updateBody(world: { x: number; y: number }): boolean {
    if (this.pointerOwnerState !== 'body' || !this.startWorld || !this.startPosition) return false;
    const plate = this.plate(this.selectedPlateIdState ?? '');
    if (!plate) return false;
    this.transientPositionState = clampPrimeTowerPosition(plate, {
      x: this.startPosition.x + world.x - this.startWorld.x,
      y: this.startPosition.y + world.y - this.startWorld.y,
    });
    this.emit();
    return true;
  }

  beginGizmo(plateId: string): boolean {
    const plate = this.plate(plateId);
    if (!this.gizmoArmedState || !plate?.eligible || plateId !== this.selectedPlateIdState
      || plateId !== this.projectionState?.currentPlateId || this.commitInFlight) return false;
    this.selectedPlateIdState = plateId;
    this.pointerOwnerState = 'gizmo';
    this.startPosition = { ...plate.position };
    this.transientPositionState = { ...plate.position };
    this.emit();
    return true;
  }

  updateGizmo(position: PrimeTowerPosition): boolean {
    if (this.pointerOwnerState !== 'gizmo') return false;
    const plate = this.plate(this.selectedPlateIdState ?? '');
    if (!plate) return false;
    this.transientPositionState = clampPrimeTowerPosition(plate, position);
    this.emit();
    return true;
  }

  endGesture(): boolean {
    if (this.pointerOwnerState === 'none') return false;
    const plateId = this.selectedPlateIdState;
    const plate = this.plate(plateId ?? '');
    const start = this.startPosition;
    const next = this.transientPositionState;
    this.pointerOwnerState = 'none';
    this.startWorld = null;
    this.startPosition = null;
    const changed = Boolean(plateId && plate && start && next &&
      (Math.abs(start.x - next.x) > 1e-7 || Math.abs(start.y - next.y) > 1e-7));
    this.emit();
    if (changed && plateId && next) void this.commit(plateId, next);
    return true;
  }

  cancelGesture(): boolean {
    if (this.pointerOwnerState === 'none') return false;
    const plate = this.plate(this.selectedPlateIdState ?? '');
    this.pointerOwnerState = 'none';
    this.startWorld = null;
    this.startPosition = null;
    this.transientPositionState = plate ? { ...plate.position } : null;
    this.emit();
    return true;
  }

  private async commit(plateId: string, position: PrimeTowerPosition): Promise<void> {
    this.commitInFlight = true;
    this.moveCommandCountState += 1;
    this.emit();
    try {
      const result = await this.port.move({
        version: 1,
        plateId,
        revision: this.port.revision(plateId),
        x: position.x,
        y: position.y,
      });
      if (result.ok) this.setProjection(result.result.projection);
      else await this.port.reconcile();
    } catch {
      await this.port.reconcile();
    } finally {
      this.commitInFlight = false;
      this.emit();
    }
  }

  private plate(plateId: string): PrimeTowerPlateProjection | undefined {
    return this.projectionState?.plates.find((plate) => plate.plateId === plateId);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
