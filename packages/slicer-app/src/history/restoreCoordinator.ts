import type { HistoryContext, RestoreResult, SlicerClient } from '@slicer/client';
import type { SceneInteractionController } from '../components/workspace/viewport/SceneInteractionController';
import type { WorkspaceSliceCoordinator } from '../components/workspace/sliceCoordinator';
import { useHistoryRestoreStore } from '../stores/useHistoryRestoreStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useSlicerStore } from '../stores/useSlicerStore';
import { useHistoryNavigationStore } from '../stores/useHistoryNavigationStore';
import { projectHistoryStatus } from '../components/workspace/actions/historyMutation';

export type HistoryRestoreAction = 'undo' | 'redo' | { jump: string };

export interface HistoryRestoreCoordinator {
  /** Returns false when the first shortcut only cancelled an active drag. */
  restore(action: HistoryRestoreAction): Promise<boolean>;
  /** Revision used to reject late structure/mesh projections. */
  currentRevision(): number;
}

export interface HistoryRestoreCoordinatorOptions {
  runtime: Pick<SlicerClient, 'undoHistory' | 'redoHistory' | 'jumpHistory' | 'cancel'>;
  sceneInteraction: SceneInteractionController;
  sliceCoordinator?: Pick<WorkspaceSliceCoordinator, 'cancelAndWait'>;
  /** Called after a successful Worker restore to trigger model projections. */
  refreshModel: () => void;
  /** Applies the stable-ID context after model structure/mesh refresh. */
  projectContext?: (context: HistoryContext, revision: number) => Promise<void> | void;
}

function restoreError(result: RestoreResult): string {
  return result.ok ? '' : result.error.message;
}

/**
 * Coordinates the only shared-app path from a history navigation request to
 * a projected model.  The Worker owns the two-phase model/cursor commit; this
 * layer owns renderer cancellation, slice invalidation, and revision fencing.
 */
export function createHistoryRestoreCoordinator({
  runtime,
  sceneInteraction,
  sliceCoordinator,
  refreshModel,
  projectContext,
}: HistoryRestoreCoordinatorOptions): HistoryRestoreCoordinator {
  let inFlight: Promise<boolean> | null = null;

  const restore = (action: HistoryRestoreAction): Promise<boolean> => {
    // A drag is a draft gesture. The first Undo/Redo cancels it and is
    // intentionally consumed; a second shortcut performs navigation.
    if (sceneInteraction.activeDrag) {
      sceneInteraction.cancelDrag();
      return Promise.resolve(false);
    }
    if (inFlight) return inFlight;
    const task = (async () => {
      const state = useHistoryRestoreStore.getState();
      state.setError(null);
      if (useSlicerStore.getState().status === 'slicing') {
        state.setPhase('cancelling-slice');
        // The bridge is synchronous, so cancel is queued behind an in-flight
        // slice. Await both to ensure no late slice result can be projected.
        const sliceWait = sliceCoordinator ? sliceCoordinator.cancelAndWait() : runtime.cancel();
        await Promise.allSettled([sliceWait]);
      }
      state.setPhase('restoring');
      const revision = state.advanceRevision();
      let result: RestoreResult;
      try {
        result = action === 'undo' ? await runtime.undoHistory()
          : action === 'redo' ? await runtime.redoHistory()
            : await runtime.jumpHistory(action.jump);
      } catch (error) {
        state.setError(error instanceof Error ? error.message : String(error));
        state.setPhase('idle');
        return false;
      }
      if (!result.ok) {
        // Worker prepare/validation failure preserves its old model/cursor.
        if (result.status) useHistoryNavigationStore.getState().setStatus(result.status);
        state.setError(restoreError(result));
        state.setPhase('idle');
        return false;
      }
      // Do not project model or context before the Worker returns success.
      projectHistoryStatus(result.status);
      useHistoryRestoreStore.getState().setSnapshotSuppressed(true);
      useSlicerStore.getState().invalidateSliceResult();
      refreshModel();
      await projectContext?.(result.context, revision);
      // A newer restore supersedes this projection; never leave the UI in a
      // restoring state for an obsolete request.
      if (useHistoryRestoreStore.getState().revision !== revision) return false;
      state.setPhase('idle');
      return true;
    })().catch((error) => {
      useHistoryRestoreStore.getState().setError(error instanceof Error ? error.message : String(error));
      useHistoryRestoreStore.getState().setPhase('idle');
      return false;
    });
    inFlight = task.finally(() => { if (inFlight === joined) inFlight = null; });
    const joined = inFlight;
    return joined;
  };

  return {
    restore,
    currentRevision: () => useHistoryRestoreStore.getState().revision,
  };
}
