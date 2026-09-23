import type { HistoryContext, NativeScopedConfigFullTransport, ProfileSnapshot, RestoreImpact, RestoreResult, SceneDelta, SlicerClient } from '@slicer/client';
import type { SceneInteractionController } from '../components/workspace/viewport/SceneInteractionController';
import { useHistoryRestoreStore } from '../stores/useHistoryRestoreStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useHistoryNavigationStore } from '../stores/useHistoryNavigationStore';
import { restoreProjectHistory } from '../components/workspace/actions/historyMutation';
import { invalidateAffectedPlateResults } from '../stores/plateResultLifecycle';
import { historyDiagnosticNow, historyRestorePath, type HistoryRestorePath, useHistoryDiagnosticsStore } from './historyDiagnostics';

export type HistoryRestoreAction = 'undo' | 'redo' | { jump: string; direction: 'undo' | 'redo' };

export interface HistoryRestoreCoordinator {
  /** Returns false when the first shortcut only cancelled an active drag. */
  restore(action: HistoryRestoreAction): Promise<boolean>;
  /** Revision used to reject late structure/mesh projections. */
  currentRevision(): number;
}

export interface HistoryRestoreCoordinatorOptions {
  runtime: Pick<SlicerClient, 'undoHistory' | 'redoHistory' | 'jumpHistory' | 'cancel' | 'getFilamentSessionSnapshot' | 'getHistoryStatus'> &
    Partial<Pick<SlicerClient, 'getRuntimeExecutionState'>>;
  sceneInteraction: SceneInteractionController;
  /**
   * Projects one successful Worker restore. The promise must settle only
   * after structure, mesh, plate, selection, and gizmo projections are safe
   * for editing; the coordinator keeps the restoring phase until then.
   */
  refreshModel: (
    context: HistoryContext,
    impact: RestoreImpact,
    sceneDelta: SceneDelta,
    nativeScopedConfig: NativeScopedConfigFullTransport,
    revision: number,
    profileSnapshot?: ProfileSnapshot,
  ) => Promise<HistoryRestorePath | void>;
  /** Best-effort preference mirror after a successful native restore. */
  publishRestoredFilamentRack?: (revision: number) => Promise<void>;
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
  refreshModel,
  publishRestoredFilamentRack,
}: HistoryRestoreCoordinatorOptions): HistoryRestoreCoordinator {
  const restore = (action: HistoryRestoreAction): Promise<boolean> => {
    if (runtime.getRuntimeExecutionState?.().serialSliceActive) {
      useHistoryRestoreStore.getState().setError('slice_busy');
      return Promise.resolve(false);
    }
    // A drag is a draft gesture. The first Undo/Redo cancels it and is
    // intentionally consumed; a second shortcut performs navigation.
    if (sceneInteraction.activeDrag) {
      sceneInteraction.cancelDrag();
      return Promise.resolve(false);
    }

    // Every request is deliberately retained as its own FIFO item.  Repeated
    // Undo or Redo therefore has the same meaning as repeated native
    // navigation, while a queued opposite direction or jump is resolved by
    // the Worker against the cursor committed by all earlier FIFO work.  Do
    // not precompute targets from React's (necessarily lagging) status.
    let revision: number | null = null;
    return restoreProjectHistory(runtime, action, async (restored) => {
      if (revision === null) throw new Error('history restore started without a revision');
      // The Worker publishes the authoritative before/after plate union.
      // Keep receipts for all other plates so their matching native results
      // remain available after navigation.
      invalidateAffectedPlateResults(runtime, restored.affectedPlateIds);
      const projectionStartedAt = historyDiagnosticNow();
      let projectionPath: HistoryRestorePath = historyRestorePath(restored.impact);
      try {
        projectionPath = await refreshModel(
          restored.context, restored.impact, restored.sceneDelta, restored.nativeScopedConfig, revision,
          restored.profileSnapshot,
        ) ?? projectionPath;
      } finally {
        useHistoryDiagnosticsStore.getState().recordProjection(
          projectionPath, historyDiagnosticNow() - projectionStartedAt,
        );
      }
      if (useHistoryRestoreStore.getState().revision !== revision) return;
      if (restored.impact.filamentRack) {
        try {
          await publishRestoredFilamentRack?.(revision);
        } catch (error) {
          // Rack preference persistence is best effort. Native history and
          // the already-published model remain authoritative.
          console.warn('remembered filament rack publication failed after history restore', error);
        }
      }
    }, async () => {
      const state = useHistoryRestoreStore.getState();
      state.setError(null);
      state.setPhase('restoring');
      revision = state.advanceRevision();
    }).then((result) => {
      const activeRevision = revision;
      if (!result.ok) {
        // Worker prepare/validation failure preserves its old model/cursor.
        if (result.status) useHistoryNavigationStore.getState().setStatus(result.status);
        if (activeRevision !== null && useHistoryRestoreStore.getState().revision === activeRevision) {
          useHistoryRestoreStore.getState().setError(restoreError(result));
          useHistoryRestoreStore.getState().setPhase('idle');
        }
        return false;
      }
      // The central history entrypoint projects status, refreshes the
      // filament revision, and keeps its mutation fence through publication.
      if (activeRevision === null || useHistoryRestoreStore.getState().revision !== activeRevision) return false;
      useHistoryRestoreStore.getState().setPhase('idle');
      return true;
    }).catch((error) => {
      if (revision !== null && useHistoryRestoreStore.getState().revision === revision) {
        useHistoryRestoreStore.getState().setError(error instanceof Error ? error.message : String(error));
        useHistoryRestoreStore.getState().setPhase('idle');
      }
      return false;
    });
  };

  return {
    restore,
    currentRevision: () => useHistoryRestoreStore.getState().revision,
  };
}
