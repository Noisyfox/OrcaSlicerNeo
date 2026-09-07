import type { HistoryContext, SlicerClient } from '@slicer/client';
import { useObjectListStore } from '../objectList/useObjectListStore';
import { projectSelection } from '../objectList/projection';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { useProjectStore } from '../../../stores/useProjectStore';
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
    projectConfigOverlay: {},
  };
}

type GateCommand = 'commit' | 'abort';

/**
 * Owns one transform gesture/command transaction.  The transaction is
 * started before renderer mutation, but the mutation callback is held behind
 * a gate until the gesture ends.  Consequently no pointer frame reaches the
 * Worker and cancellation never writes renderer draft transforms to it.
 */
export class TransformHistoryCoordinator {
  private active: {
    release: (command: GateCommand) => void;
    task: Promise<{ result: { ok: boolean; error?: string; plateSession?: import('@slicer/client').PlateSessionMutation }; status: import('@slicer/client').HistoryStatus }>;
  } | null = null;

  constructor(
    private readonly runtime: TransformHistoryRuntime,
    private readonly sceneInteraction: SceneInteractionController,
    private readonly onError: (error: unknown) => void = (error) => console.warn('transform history unavailable', error),
  ) {}

  begin(label: string): void {
    if (this.active) return;
    const beforeContext = historyContextForScene(this.sceneInteraction);
    let release!: (command: GateCommand) => void;
    const gate = new Promise<GateCommand>((resolve) => { release = resolve; });
    const task = this.runtime.runProjectHistoryTransaction(
      label,
      'project',
      beforeContext,
      async () => {
        const command = await gate;
        if (command === 'abort') throw new TransformCancelledError();
        const result = await syncModelTransforms(this.runtime, glVolumeCollection.volumes);
        if (!result.ok) throw new Error(result.error ?? 'model transform synchronization failed');
        applySettledTransformSyncResult(result);
        return result;
      },
      () => historyContextForScene(this.sceneInteraction),
    );
    this.active = { release, task };
    // Keep UI mutation APIs synchronous while preserving a visible error if a
    // Worker transaction fails asynchronously.
    void task.catch((error) => this.onError(error));
  }

  async commit(): Promise<void> {
    const current = this.active;
    if (!current) return;
    this.active = null;
    current.release('commit');
    try {
      const { status } = await current.task;
      // Transform edits are now history-authoritative; do not leave a legacy
      // dirty reason competing with the saved-checkpoint projection.
      useProjectStore.getState().setProject({ dirty: status.dirty, dirtyReasons: [] });
    } catch (error) {
      this.onError(error);
    }
  }

  async abort(): Promise<void> {
    const current = this.active;
    if (!current) return;
    this.active = null;
    current.release('abort');
    try { await current.task; } catch { /* the helper aborts the Worker tx */ }
  }
}

export class TransformCancelledError extends Error {
  constructor() { super('transform gesture cancelled'); }
}
