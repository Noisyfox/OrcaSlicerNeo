import type { HistoryContext, HistoryStatus, ModelStructureResult, SlicerClient } from '@slicer/client';
import { useObjectListStore } from '../objectList/useObjectListStore';
import { projectSelection } from '../objectList/projection';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import { glVolumeCollection } from '../viewport/GLVolume';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { syncModelTransforms, syncModelTransformsAtomically } from './syncModelTransforms';
import { applySettledTransformSyncResult } from './persistModelTransforms';
import {
  captureTransformReservationState,
  executeProjectHistoryTransaction,
  readTransformReservationState,
} from './historyMutation';

type TransformHistoryRuntime = Pick<SlicerClient,
  'runProjectHistoryTransaction' | 'setModelTransforms' | 'getFilamentSessionSnapshot' |
  'getHistoryStatus' | 'getModelStructure' | 'getPlateSessionSnapshot'> &
  Partial<Pick<SlicerClient, 'recomputePlateMembership'>>;

/** Build the Worker-owned context projection without retaining renderer state. */
export function historyContextForScene(sceneInteraction: SceneInteractionController): HistoryContext {
  const objectList = useObjectListStore.getState();
  const selection = projectSelection(
    objectList.structure,
    sceneInteraction.selectedVolumes().map((volume) => volume.buffer),
    objectList.highlightLevel,
  );
  return {
    selection: {
      mode: sceneInteraction.selectionMode === 'volume' ? 'part' : sceneInteraction.selectionMode,
      objectIds: [...selection.objectIds].sort((a, b) => a - b),
      partIds: [...selection.volumeIds].sort((a, b) => a - b),
      instanceIds: [...selection.instanceIds].sort((a, b) => a - b),
    },
    activePlateId: usePlateSessionStore.getState().snapshot?.currentPlateId ?? null,
    gizmo: sceneInteraction.gizmo ? { type: sceneInteraction.gizmo } : null,
    projectConfigOverlay: useSettingsStore.getState().overlay as unknown as HistoryContext['projectConfigOverlay'],
  };
}

type GateCommand = 'commit' | 'abort';
type TransactionResult = {
  result: { ok: boolean; error?: string; plateSession?: import('@slicer/client').PlateSessionMutation };
  status: HistoryStatus | null;
};

export type TransformGestureResult =
  | { outcome: 'committed' }
  | { outcome: 'cancelled' }
  | { outcome: 'stale'; error: string }
  | { outcome: 'failed'; error: string };

type CompositeTarget = { objectIdx: number; volumeIdx: number; instanceIdx: number };
type StableTarget = CompositeTarget & { objectId: number; volumeId: number; instanceId: number };
type TransformReservation = { revision: number; targets: readonly StableTarget[] };
type RendererTransform = Parameters<typeof syncModelTransforms>[1][number];

type PendingTransformTransaction = {
  label: string;
  beforeContext: HistoryContext;
  startTargets: readonly CompositeTarget[];
  startTransforms: readonly RendererTransform[];
  decision: GateCommand | null;
  finalTransforms: Parameters<typeof syncModelTransforms>[1] | null;
  reservation: TransformReservation | null;
  reservationError: Error | null;
  reservationReady: boolean;
  reservationStarted: boolean;
  task: Promise<TransactionResult> | null;
  resolve: (result: TransformGestureResult) => void;
  completion: Promise<TransformGestureResult>;
};

/**
 * Keeps renderer drag frames local. Pointer-down captures only a Worker
 * revision/identity reservation; it never owns the project FIFO, lease, or a
 * native history transaction. Pointer-up rechecks that reservation inside the
 * FIFO before it opens the one short native transaction for the final batch.
 */
export class TransformHistoryCoordinator {
  private readonly pending: PendingTransformTransaction[] = [];
  private running: PendingTransformTransaction | null = null;

  constructor(
    private readonly runtime: TransformHistoryRuntime,
    private readonly sceneInteraction: SceneInteractionController,
    private readonly onError: (error: unknown) => void = (error) => console.warn('transform history unavailable', error),
    private reconcile: (() => Promise<void>) | null = null,
  ) {}

  /** Installed by Workspace so a stale/failed draft is rebuilt from Worker authority. */
  setReconcile(reconcile: (() => Promise<void>) | null): void { this.reconcile = reconcile; }

  begin(label: string): boolean {
    // A gesture cannot start from a renderer projection while another project
    // publication is replacing it. This does not reserve the FIFO: after its
    // short read-only reservation completes, other mutations continue freely.
    if (useProjectStore.getState().projectMutationPendingCount !== 0) return false;
    const beforeContext = historyContextForScene(this.sceneInteraction);
    const startTransforms = this.captureTransforms();
    const startTargets = compositeTargetsFor(startTransforms);
    if (startTargets.length === 0) return false;
    let resolve!: (result: TransformGestureResult) => void;
    const completion = new Promise<TransformGestureResult>((done) => { resolve = done; });
    const pending: PendingTransformTransaction = {
      label, beforeContext, startTargets, startTransforms, decision: null, finalTransforms: null,
      reservation: null, reservationError: null, reservationReady: false, reservationStarted: false, task: null, resolve, completion,
    };
    this.pending.push(pending);
    this.startHeadReservation();
    return true;
  }

  async commit(): Promise<TransformGestureResult> {
    const current = this.latestOpenTransaction();
    if (!current) return { outcome: 'cancelled' };
    const currentTransforms = this.captureTransforms();
    const changed = changedTransforms(current.startTransforms, currentTransforms);
    // Public callers can commit directly without a scene delta. Preserve that
    // defensive behavior, while real gestures avoid serializing every static
    // renderer composite to the Worker.
    current.finalTransforms = changed.length > 0 ? changed : currentTransforms;
    current.decision = 'commit';
    this.pump();
    return current.completion;
  }

  async abort(): Promise<TransformGestureResult> {
    const current = this.latestOpenTransaction();
    if (!current) return { outcome: 'cancelled' };
    current.decision = 'abort';
    this.pump();
    return current.completion;
  }

  private latestOpenTransaction(): PendingTransformTransaction | null {
    for (let index = this.pending.length - 1; index >= 0; index--) {
      const transaction = this.pending[index];
      if (transaction.decision === null) return transaction;
    }
    return null;
  }

  private async captureReservation(pending: PendingTransformTransaction): Promise<void> {
    try {
      const { status, structure } = await captureTransformReservationState(this.runtime);
      if (!Number.isSafeInteger(status.revision))
        throw new Error('transform reservation has no native revision');
      if (status.activeTransactionId)
        throw new Error('transform reservation cannot start during a native transaction');
      const targets = stableTargetsFor(structure, pending.startTargets);
      pending.reservation = { revision: status.revision, targets };
    } catch (error) {
      pending.reservationError = asError(error);
    } finally {
      pending.reservationReady = true;
      this.pump();
    }
  }

  /** Keep rapid discrete transforms ordered without letting a pointer draft
   * reserve the FIFO. Only the head owns a short reservation read. */
  private startHeadReservation(): void {
    const head = this.pending[0];
    if (!head || head.reservationStarted) return;
    head.reservationStarted = true;
    void this.captureReservation(head);
  }

  /** A release may enter the FIFO only after its reservation is available. */
  private pump(): void {
    if (this.running) return;
    const next = this.pending[0];
    if (!next || next.decision === null) return;
    if (next.decision === 'abort') {
      this.finish(next, { outcome: 'cancelled' });
      return;
    }
    if (!next.reservationReady) return;
    if (!next.reservation) {
      const error = next.reservationError?.message ?? 'transform reservation was unavailable';
      void this.reconcile?.().catch((reconcileError) => this.onError(reconcileError));
      this.onError(new Error(error));
      this.finish(next, { outcome: 'failed', error });
      return;
    }
    this.running = next;
    next.task = executeProjectHistoryTransaction(
      this.runtime,
      next.label,
      next.beforeContext,
      async (transactionId) => {
        const result = await syncModelTransformsAtomically(this.runtime, transactionId,
          next.finalTransforms ?? this.captureTransforms());
        if (!result.ok) throw new Error(result.error ?? 'model transform synchronization failed');
        applySettledTransformSyncResult(result);
        return result;
      },
      () => historyContextForScene(this.sceneInteraction),
      undefined,
      undefined,
      async () => { await this.reconcile?.(); },
      async () => this.validateReservation(next),
    );
    void next.task.then((response) => {
      if (response.result.ok) this.finish(next, { outcome: 'committed' });
      else if (isReservationError(response.result.error)) {
        const error = response.result.error ?? 'transform reservation is stale';
        this.onError(new TransformReservationStaleError(error));
        this.finish(next, { outcome: 'stale', error });
      } else {
        const error = response.result.error ?? 'transform history transaction failed';
        this.onError(new Error(error));
        this.finish(next, { outcome: 'failed', error });
      }
    }).catch((error) => {
      const message = asError(error).message;
      this.onError(error);
      this.finish(next, { outcome: 'failed', error: message });
    });
  }

  /** Runs in the release FIFO before beginHistory can capture a new base. */
  private async validateReservation(pending: PendingTransformTransaction): Promise<void> {
    const reservation = pending.reservation;
    if (!reservation) throw new TransformReservationStaleError('transform reservation is unavailable');
    const currentTransforms = this.captureTransforms();
    if (!sameCompositeTargets(pending.startTargets, compositeTargetsFor(currentTransforms)))
      throw new TransformReservationStaleError('transform reservation renderer targets are stale');
    const { status, structure } = await readTransformReservationState(this.runtime);
    if (status.revision !== reservation.revision)
      throw new TransformReservationStaleError('transform reservation native revision is stale');
    if (!sameStableTargets(reservation.targets, stableTargetsFor(structure, compositeTargetsFor(currentTransforms))))
      throw new TransformReservationStaleError('transform reservation target identity is stale');
  }

  private finish(pending: PendingTransformTransaction, result: TransformGestureResult): void {
    if (this.pending[0] !== pending) return;
    this.running = null;
    this.pending.shift();
    pending.resolve(result);
    this.startHeadReservation();
    this.pump();
  }

  private captureTransforms(): Parameters<typeof syncModelTransforms>[1] {
    return glVolumeCollection.volumes.map((volume) => ({
      buffer: { objectIdx: volume.buffer.objectIdx, volumeIdx: volume.buffer.volumeIdx, instanceIdx: volume.buffer.instanceIdx },
      instanceTransform: structuredClone(volume.instanceTransform),
      volumeTransform: structuredClone(volume.volumeTransform),
    }));
  }

}

export class TransformReservationStaleError extends Error {
  constructor(message: string) { super(message); }
}

function compositeTargetsFor(transforms: Parameters<typeof syncModelTransforms>[1]): readonly CompositeTarget[] {
  const targets = transforms.map(({ buffer }) => ({ objectIdx: buffer.objectIdx, volumeIdx: buffer.volumeIdx, instanceIdx: buffer.instanceIdx }));
  if (new Set(targets.map(compositeTargetKey)).size !== targets.length)
    throw new Error('transform reservation contains duplicate renderer targets');
  return targets.sort(compareCompositeTargets);
}

function changedTransforms(
  before: readonly RendererTransform[],
  after: readonly RendererTransform[],
): readonly RendererTransform[] {
  const beforeByTarget = new Map(before.map((transform) => [compositeTargetKey(transform.buffer), transform]));
  return after.filter((transform) => {
    const previous = beforeByTarget.get(compositeTargetKey(transform.buffer));
    return previous === undefined || !sameTransform(previous.instanceTransform, transform.instanceTransform) ||
      !sameTransform(previous.volumeTransform, transform.volumeTransform);
  });
}

function sameTransform(left: RendererTransform['instanceTransform'], right: RendererTransform['instanceTransform']): boolean {
  const fields: (keyof RendererTransform['instanceTransform'])[] = ['offset', 'rotation', 'scale', 'mirror', 'matrix'];
  return fields.every((field) => {
    const leftValue = left[field];
    const rightValue = right[field];
    if (leftValue === undefined || rightValue === undefined) return leftValue === rightValue;
    return leftValue.length === rightValue.length && leftValue.every((value, index) => value === rightValue[index]);
  });
}

function stableTargetsFor(structure: ModelStructureResult, targets: readonly CompositeTarget[]): readonly StableTarget[] {
  if (!structure.ok || !Array.isArray(structure.objects))
    throw new TransformReservationStaleError(structure.error ?? 'transform reservation model structure is unavailable');
  return targets.map((target) => {
    const object = structure.objects.find((candidate) => candidate.index === target.objectIdx);
    const volume = object?.volumes.find((candidate) => candidate.index === target.volumeIdx);
    const instance = object?.instances.find((candidate) => candidate.index === target.instanceIdx);
    if (!object || !volume || !instance)
      throw new TransformReservationStaleError('transform reservation target identity is stale');
    return { ...target, objectId: object.id, volumeId: volume.id, instanceId: instance.id };
  }).sort(compareCompositeTargets);
}

function sameCompositeTargets(left: readonly CompositeTarget[], right: readonly CompositeTarget[]): boolean {
  return left.length === right.length && left.every((entry, index) => compositeTargetKey(entry) === compositeTargetKey(right[index]!));
}

function sameStableTargets(left: readonly StableTarget[], right: readonly StableTarget[]): boolean {
  return left.length === right.length && left.every((entry, index) =>
    compositeTargetKey(entry) === compositeTargetKey(right[index]!) &&
    entry.objectId === right[index]!.objectId && entry.volumeId === right[index]!.volumeId &&
    entry.instanceId === right[index]!.instanceId);
}

function compositeTargetKey(target: CompositeTarget): string {
  return `${target.objectIdx}:${target.volumeIdx}:${target.instanceIdx}`;
}

function compareCompositeTargets(left: CompositeTarget, right: CompositeTarget): number {
  return compositeTargetKey(left).localeCompare(compositeTargetKey(right), 'en');
}

function isReservationError(error: string | undefined): boolean {
  return error?.includes('transform reservation') ?? false;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
