import type { HistoryContext, SlicerClient } from '@slicer/client';
import { useObjectListStore } from '../objectList/useObjectListStore';
import { projectSelection } from '../objectList/projection';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { glVolumeCollection } from '../viewport/GLVolume';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { syncModelTransforms, syncModelTransformsAtomically } from './syncModelTransforms';
import { applySettledTransformSyncResult } from './persistModelTransforms';
import { executeProjectHistoryTransaction } from './historyMutation';

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
  status: import('@slicer/client').HistoryStatus | null;
};

type PendingTransformTransaction = {
  label: string;
  beforeContext: HistoryContext;
  release: (command: GateCommand) => void;
  gate: Promise<GateCommand>;
  decision: GateCommand | null;
  finalTransforms: Parameters<typeof syncModelTransforms>[1] | null;
  started: boolean;
  task: Promise<TransactionResult> | null;
  result: TransactionResult | null;
  resolve: () => void;
  completion: Promise<void>;
};

/**
 * Owns one transform gesture/command transaction.  The transaction is
 * started before renderer mutation, but the mutation callback is held behind
 * a gate until the gesture ends.  Consequently no pointer frame reaches the
 * Worker and cancellation never writes renderer draft transforms to it.
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

  /** Installed by Workspace so every cancelled/failed draft is rebuilt from
   * the Worker before the shared mutation fence is released. */
  setReconcile(reconcile: (() => Promise<void>) | null): void { this.reconcile = reconcile; }

  begin(label: string): void {
    const beforeContext = historyContextForScene(this.sceneInteraction);
    let release!: (command: GateCommand) => void;
    const gate = new Promise<GateCommand>((resolve) => { release = resolve; });
    let resolve!: () => void;
    const completion = new Promise<void>((done) => { resolve = done; });
    this.pending.push({
      label,
      beforeContext,
      release,
      gate,
      decision: null,
      finalTransforms: null,
      started: false,
      task: null,
      result: null,
      resolve,
      completion,
    });
    this.pump();
  }

  async commit(): Promise<void> {
    const current = this.latestOpenTransaction();
    if (!current) return;
    current.finalTransforms = this.captureTransforms();
    current.decision = 'commit';
    current.release('commit');
    await current.completion;
  }

  async abort(): Promise<void> {
    const current = this.latestOpenTransaction();
    if (!current) return;
    current.decision = 'abort';
    current.release('abort');
    await current.completion;
  }

  private latestOpenTransaction(): PendingTransformTransaction | null {
    for (let index = this.pending.length - 1; index >= 0; index--) {
      const transaction = this.pending[index];
      if (transaction.decision === null) return transaction;
    }
    return null;
  }

  /** Start at most one Worker transaction; later commands wait for its full
   * settle before beginHistory, preserving each rapid discrete edit as its
   * own native before/after pair. */
  private pump(): void {
    if (this.running) return;
    const next = this.pending[0];
    if (!next) return;
    if (next.decision === 'abort' && !next.started) {
      this.pending.shift();
      next.resolve();
      this.pump();
      return;
    }
    if (next.started) return;
    next.started = true;
    this.running = next;
    try {
      next.task = executeProjectHistoryTransaction(
        this.runtime,
        next.label,
        next.beforeContext,
        async (transactionId) => {
          const command = await next.gate;
          if (command === 'abort') throw new TransformCancelledError();
          const result = await syncModelTransformsAtomically(this.runtime, transactionId,
            next.finalTransforms ?? this.captureTransforms());
          if (!result.ok) throw new Error(result.error ?? 'model transform synchronization failed');
          applySettledTransformSyncResult(result);
          return result;
        },
        () => historyContextForScene(this.sceneInteraction),
        undefined,
        (error) => { try { this.onError(error); } catch { /* reporting cannot retain the fence */ } },
        async () => { await this.reconcile?.(); },
      );
    } catch (error) {
      try { this.onError(error); } catch { /* reporting must not retain the mutation fence */ }
      this.running = null;
      this.pending.shift();
      next.resolve();
      this.pump();
      return;
    }
    const task = next.task;
    void task!.then((result) => {
      next.result = result;
    }).catch((error) => {
      this.onError(error);
    }).finally(async () => {
      this.running = null;
      this.pending.shift();
      next.resolve();
      this.pump();
    });
  }

  private captureTransforms(): Parameters<typeof syncModelTransforms>[1] {
    return glVolumeCollection.volumes.map((volume) => ({
      buffer: {
        objectIdx: volume.buffer.objectIdx,
        volumeIdx: volume.buffer.volumeIdx,
        instanceIdx: volume.buffer.instanceIdx,
      },
      instanceTransform: structuredClone(volume.instanceTransform),
      volumeTransform: structuredClone(volume.volumeTransform),
    }));
  }
}

export class TransformCancelledError extends Error {
  constructor() { super('transform gesture cancelled'); }
}
