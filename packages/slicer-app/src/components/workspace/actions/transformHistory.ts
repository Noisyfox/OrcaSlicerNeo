import type { HistoryContext, SlicerClient } from '@slicer/client';
import { useObjectListStore } from '../objectList/useObjectListStore';
import { projectSelection } from '../objectList/projection';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { glVolumeCollection } from '../viewport/GLVolume';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { syncModelTransforms } from './syncModelTransforms';
import { applySettledTransformSyncResult } from './persistModelTransforms';

type TransformHistoryRuntime = Pick<SlicerClient, 'runProjectHistoryTransaction' | 'setModelTransform'> &
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
  status: import('@slicer/client').HistoryStatus;
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
  ) {}

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
    if (current.result) {
      // Transform edits are now history-authoritative; do not leave a legacy
      // dirty reason competing with the saved-checkpoint projection.
      useProjectStore.getState().setProject({ dirty: current.result.status.dirty, dirtyReasons: [] });
    }
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
    next.task = this.runtime.runProjectHistoryTransaction(
      next.label,
      'project',
      next.beforeContext,
      async () => {
        const command = await next.gate;
        if (command === 'abort') throw new TransformCancelledError();
        const result = await syncModelTransforms(this.runtime, next.finalTransforms ?? this.captureTransforms());
        if (!result.ok) throw new Error(result.error ?? 'model transform synchronization failed');
        applySettledTransformSyncResult(result);
        return result;
      },
      () => historyContextForScene(this.sceneInteraction),
    );
    void next.task.then((result) => {
      next.result = result;
    }).catch((error) => {
      this.onError(error);
    }).finally(() => {
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
