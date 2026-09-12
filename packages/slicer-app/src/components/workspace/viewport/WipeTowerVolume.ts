import * as THREE from 'three';
import type { HistoryStatus, PlateSessionSnapshot, PrimeTowerMoveRequest, PrimeTowerMoveResultOrError, PrimeTowerPlateProjection, PrimeTowerProjection, PrimeTowerRestoreReceipt } from '@slicer/client';
import { useEffect, useState } from 'react';
import { attachBoundsTree, disposeBVHGeometry, GLVolume, type BVHBufferGeometry } from './GLVolume';
import { clampPrimeTowerPosition, type PrimeTowerPosition } from './primeTowerGeometry';
import { runProjectMutationOperation } from '../actions/historyMutation';

const CUBE_INDICES = new Uint32Array([
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
  0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
  2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
]);

/**
 * The Neo equivalent of Orca's GLWipeTowerVolume: a normal scene volume with
 * a tagged identity and a compact per-band renderer.  It is deliberately not
 * a ModelObject and never enters the Object List or model-history pipeline.
 */
export class WipeTowerVolume extends GLVolume {
  declare kind: 'wipe-tower';
  readonly plateId: string;
  private projectionState: PrimeTowerPlateProjection;
  private originState: readonly [number, number, number];
  private bandGeometries: BVHBufferGeometry[] = [];
  private bandGeometrySignature = '';

  constructor(projection: PrimeTowerPlateProjection, origin: readonly [number, number, number], ordinal: number) {
    const height = Math.max(projection.height, 0.1);
    const positions = new Float32Array([
      0, 0, 0, projection.width, 0, 0, projection.width, projection.depth, 0, 0, projection.depth, 0,
      0, 0, height, projection.width, 0, height, projection.width, projection.depth, height, 0, projection.depth, height,
    ]);
    super({
      // Negative IDs reserve this scene-only object outside Worker model IDs.
      objectIdx: -1001 - ordinal,
      volumeIdx: 0,
      instanceIdx: 0,
      positions,
      vertexCount: 8,
      indices: CUBE_INDICES,
      indexCount: CUBE_INDICES.length,
      offset: [origin[0] + projection.position.x, origin[1] + projection.position.y, origin[2]],
      instanceTransform: {
        offset: [origin[0] + projection.position.x, origin[1] + projection.position.y, origin[2]],
        rotation: [0, 0, projection.rotation * Math.PI / 180], scale: [1, 1, 1], mirror: [1, 1, 1],
      },
      volumeTransform: { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] },
    });
    this.kind = 'wipe-tower';
    this.plateId = projection.plateId;
    this.projectionState = projection;
    this.originState = origin;
    this.rebuildBandGeometries(projection);
  }

  get projection(): PrimeTowerPlateProjection { return this.projectionState; }
  get position(): PrimeTowerPosition {
    return { x: this.instanceTransform.offset[0] - this.originState[0], y: this.instanceTransform.offset[1] - this.originState[1] };
  }

  positionForTransform(offset: readonly [number, number, number]): PrimeTowerPosition {
    return { x: offset[0] - this.originState[0], y: offset[1] - this.originState[1] };
  }

  reconcile(projection: PrimeTowerPlateProjection, origin: readonly [number, number, number]): void {
    this.rebuildBandGeometries(projection);
    this.projectionState = projection;
    this.originState = origin;
    this.instanceTransform = {
      ...this.instanceTransform,
      offset: [origin[0] + projection.position.x, origin[1] + projection.position.y, origin[2]],
      rotation: [0, 0, projection.rotation * Math.PI / 180],
      scale: [1, 1, 1], mirror: [1, 1, 1],
    };
  }

  setTransientPosition(requested: PrimeTowerPosition): void {
    const position = clampPrimeTowerPosition(this.projectionState, requested);
    this.instanceTransform = {
      ...this.instanceTransform,
      offset: [this.originState[0] + position.x, this.originState[1] + position.y, this.originState[2]],
      rotation: [0, 0, this.projectionState.rotation * Math.PI / 180],
      scale: [1, 1, 1], mirror: [1, 1, 1],
    };
  }

  /** Geometry is owned by the volume rather than by R3F's JSX primitives. */
  getBandGeometry(index: number): BVHBufferGeometry {
    const geometry = this.bandGeometries[index];
    if (!geometry) throw new Error(`Missing Prime Tower band geometry ${index}`);
    return geometry;
  }

  override dispose(): void {
    for (const geometry of this.bandGeometries) disposeBVHGeometry(geometry);
    this.bandGeometries = [];
    super.dispose();
  }

  private rebuildBandGeometries(projection: PrimeTowerPlateProjection): void {
    const signature = JSON.stringify({
      width: projection.width,
      height: Math.max(projection.height, 0.1),
      bands: projection.bands.map((band, index) => ({
        index,
        startDepth: band.startDepth,
        endDepth: band.endDepth,
      })),
    });
    if (signature === this.bandGeometrySignature) return;

    const next = projection.bands.map((band) => attachBoundsTree(new THREE.BoxGeometry(
      projection.width,
      band.endDepth - band.startDepth,
      Math.max(projection.height, 0.1),
    )));
    for (const geometry of this.bandGeometries) disposeBVHGeometry(geometry);
    this.bandGeometries = next;
    this.bandGeometrySignature = signature;
  }
}

/** Worker command boundary for authoritative Prime Tower mutations. */
export interface PrimeTowerCommandPort {
  move(request: PrimeTowerMoveRequest): Promise<PrimeTowerMoveResultOrError>;
  reconcile(): Promise<void>;
  revision(plateId: string): number;
  /** Project history status without re-entering the shared FIFO. */
  publishHistoryStatus?(status: HistoryStatus): Promise<void>;
}

/** Aggregate-only timing sink used by the E2E history diagnostic. */
export interface PrimeTowerProjectionDiagnostics {
  recordSetProjection(durationMs: number): void;
  recordReconcile(durationMs: number): void;
  recordEmit(durationMs: number): void;
}

function projectionDiagnosticNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Worker projection and native X/Y commit boundary; it owns no selection,
 * gizmo, or pointer state. */
export class WipeTowerVolumeCollection {
  private readonly listeners = new Set<() => void>();
  private projectionState: PrimeTowerProjection | null = null;
  private volumesState: WipeTowerVolume[] = [];
  private sessionState: PlateSessionSnapshot | null = null;
  private moveCommandCountState = 0;
  private commitInFlight = false;

  constructor(
    private readonly commandPort: PrimeTowerCommandPort,
    private readonly diagnostics?: PrimeTowerProjectionDiagnostics,
  ) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  get projection(): PrimeTowerProjection | null { return this.projectionState; }
  get volumes(): readonly WipeTowerVolume[] { return this.volumesState; }
  get moveCommandCount(): number { return this.moveCommandCountState; }
  get busy(): boolean { return this.commitInFlight; }

  setProjection(projection: PrimeTowerProjection | null, session?: PlateSessionSnapshot | null): void {
    const setStartedAt = projectionDiagnosticNow();
    this.projectionState = projection;
    if (session !== undefined) this.sessionState = session;
    const activeSession = this.sessionState;
    if (!projection || !activeSession) {
      this.volumesState.forEach((volume) => volume.dispose());
      this.volumesState = [];
      this.emitProjection(setStartedAt);
      return;
    }
    const prior = new Map(this.volumesState.map((volume) => [volume.plateId, volume]));
    const next: WipeTowerVolume[] = [];
    projection.plates.forEach((plate, ordinal) => {
      if (!plate.eligible) return;
      const sessionPlate = activeSession.plates.find((candidate) => candidate.plateId === plate.plateId);
      if (!sessionPlate) return;
      const priorVolume = prior.get(plate.plateId);
      const volume = priorVolume
        && priorVolume.projection.width === plate.width
        && priorVolume.projection.depth === plate.depth
        && priorVolume.projection.height === plate.height
        ? priorVolume : new WipeTowerVolume(plate, sessionPlate.origin, ordinal);
      volume.reconcile(plate, sessionPlate.origin);
      volume.selectable = plate.plateId === projection.currentPlateId;
      next.push(volume);
    });
    for (const volume of this.volumesState) if (!next.includes(volume)) volume.dispose();
    this.volumesState = next;
    this.emitProjection(setStartedAt);
  }

  /** Apply the plate-local authoritative response from a completed tower move. */
  setPlatePosition(plateId: string, position: PrimeTowerPosition, footprint: PrimeTowerPlateProjection['footprint']): void {
    const projection = this.projectionState;
    if (!projection || !projection.plates.some((candidate) => candidate.plateId === plateId)) return;
    this.setProjection({
      ...projection,
      plates: projection.plates.map((candidate) => candidate.plateId === plateId ? { ...candidate, position, footprint } : candidate),
    });
  }

  /**
   * Apply one normalized direct-history receipt without re-reading the
   * all-plate projection.  A receipt deliberately has no eligibility, band,
   * or build-area data, so it is usable only when the retained projection and
   * the freshly-read native plate session prove that every omitted fact is
   * still valid.  Returning false makes the caller take the authoritative
   * full-projection path instead.
   */
  applyRestoreReceipt(receipt: PrimeTowerRestoreReceipt, session: PlateSessionSnapshot): boolean {
    const projection = this.projectionState;
    if (receipt.version !== 1 || !projection || !session.ok || session.version !== 1 ||
        projection.version !== 1 || session.inputRevisions?.[receipt.plateId] !== receipt.revision ||
        !session.plates.some((plate) => plate.plateId === receipt.plateId) ||
        !projection.plates.some((plate) => plate.plateId === receipt.plateId)) return false;
    if (receipt.state === 'cleared') {
      this.setProjection({
        ...projection,
        currentPlateId: session.currentPlateId,
        plates: projection.plates.filter((plate) => plate.plateId !== receipt.plateId),
      }, session);
      return true;
    }
    this.setProjection({
      ...projection,
      currentPlateId: session.currentPlateId,
      plates: projection.plates.map((plate) => plate.plateId === receipt.plateId
        ? { ...plate, position: receipt.position, footprint: receipt.footprint }
        : plate),
    }, session);
    return true;
  }

  async commit(volume: WipeTowerVolume): Promise<void> {
    if (this.commitInFlight) return;
    this.commitInFlight = true;
    this.moveCommandCountState += 1;
    this.emit();
    try {
      // Prime Tower is a native history-producing project mutation even
      // though its bridge command is a single atomic operation rather than a
      // begin/commit transaction. Keep it in the same FIFO and hold the
      // publication fence through the authoritative projection update. This
      // prevents a filament command or model history operation from observing
      // the old wipe_tower_x/y revision between pointer-up and publication.
      await runProjectMutationOperation(async () => {
        const position = volume.position;
        const result = await this.commandPort.move({ version: 1, plateId: volume.plateId, revision: this.commandPort.revision(volume.plateId), x: position.x, y: position.y });
        if (result.ok) {
          this.setPlatePosition(result.result.mutation.plateId, result.result.mutation.position, result.result.mutation.footprint);
          await this.commandPort.publishHistoryStatus?.(result.result.historyStatus);
        }
        else await this.commandPort.reconcile();
      });
    } catch {
      // The native command already reconciles its own validation failures;
      // this catch is only for unexpected queue/transport failures.
      await this.commandPort.reconcile();
    } finally {
      this.commitInFlight = false;
      this.emit();
    }
  }

  private emitProjection(setStartedAt: number): void {
    this.diagnostics?.recordReconcile(projectionDiagnosticNow() - setStartedAt);
    const emitStartedAt = projectionDiagnosticNow();
    this.emit();
    this.diagnostics?.recordEmit(projectionDiagnosticNow() - emitStartedAt);
    this.diagnostics?.recordSetProjection(projectionDiagnosticNow() - setStartedAt);
  }

  private emit(): void { for (const listener of this.listeners) listener(); }
}

export function useWipeTowerVolumeVersion(collection: WipeTowerVolumeCollection | undefined): number {
  const [version, setVersion] = useState(0);
  useEffect(() => collection?.subscribe(() => setVersion((current) => current + 1)), [collection]);
  return version;
}
