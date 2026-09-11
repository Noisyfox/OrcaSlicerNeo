import type {
  HistoryContext,
  HistoryStatus,
  ModelStructureResult,
} from '@slicer/client';
import type { SlicerRuntime } from '@orca/platform-contract';
import { useObjectListStore } from '../objectList/useObjectListStore';
import { projectSelection } from '../objectList/projection';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { refreshFilamentSession } from '../../../stores/useFilamentSessionStore';
import { acquireProjectMutationLease, enqueueProjectMutationOperation } from '../../../history/projectMutationGate';
import { projectHistoryStatus } from '../../../history/projectHistoryStatus';

export { projectHistoryStatus } from '../../../history/projectHistoryStatus';

export type HistoryMutationResult<T> = {
  result: T;
  status: HistoryStatus | null;
};

type HistoryMutationRuntime = Pick<SlicerRuntime,
  'runProjectHistoryTransaction' | 'getFilamentSessionSnapshot' | 'getHistoryStatus' |
  'getModelStructure' | 'getPlateSessionSnapshot'>;

/** Build a JSON-safe context from the current stable-ID ObjectList projection. */
export function historyContextForStructure(sceneInteraction?: SceneInteractionController | null): HistoryContext {
  const objectList = useObjectListStore.getState();
  const projection = sceneInteraction
    ? projectSelection(
      objectList.structure,
      sceneInteraction.selectedVolumes().map((volume) => volume.buffer),
      objectList.highlightLevel,
    )
    : objectList.projection;
  const mode = sceneInteraction?.selectionMode === 'volume'
    ? 'part'
    : sceneInteraction?.selectionMode ?? (projection.volumeIds.size > 0 ? 'part' : 'object');
  return {
    selection: {
      mode,
      objectIds: [...projection.objectIds].sort((a, b) => a - b),
      partIds: [...projection.volumeIds].sort((a, b) => a - b),
      instanceIds: [...projection.instanceIds].sort((a, b) => a - b),
    },
    activePlateId: usePlateSessionStore.getState().snapshot?.currentPlateId ?? null,
    gizmo: sceneInteraction?.gizmo ? { type: sceneInteraction.gizmo } : null,
    projectConfigOverlay: useSettingsStore.getState().overlay as unknown as HistoryContext['projectConfigOverlay'],
  };
}

/** Remove IDs that a structural mutation deleted before its renderer refresh. */
function projectContextOntoStructure(context: HistoryContext, structure: Awaited<ReturnType<SlicerRuntime['getModelStructure']>>): HistoryContext {
  if (!structure.ok || !structure.objects) return context;
  const objectIds = new Set(structure.objects.map((object) => object.id));
  const partIds = new Set(structure.objects.flatMap((object) => object.volumes.map((volume) => volume.id)));
  const instanceIds = new Set(structure.objects.flatMap((object) => object.instances.map((instance) => instance.id)));
  return {
    ...context,
    selection: {
      ...context.selection,
      objectIds: context.selection.objectIds.filter((id) => objectIds.has(id)),
      partIds: context.selection.partIds.filter((id) => partIds.has(id)),
      instanceIds: context.selection.instanceIds.filter((id) => instanceIds.has(id)),
    },
  };
}

type MutationResponse = { ok?: boolean; error?: string };
export interface ProjectHistoryMutationOptions<T extends MutationResponse = MutationResponse> {
  /** Renderer/application publication that must complete before the fence is released. */
  publish?: (result: T, status: HistoryStatus | null) => Promise<void> | void;
}

/**
 * Application history is a single ordered stream.  The Worker already
 * rejects overlapping native transactions, but that is too late to protect
 * the React projections (and the filament revision token).  Keeping the
 * queue here means every history-producing command and restore has one
 * lifecycle: acquire fence -> mutate/restore -> refresh projections ->
 * publish -> release fence.
 */
function enqueueHistoryOperation<T>(operation: () => Promise<T>): Promise<T> {
  return enqueueProjectMutationOperation(operation);
}

/**
 * A short read-only reservation shares ordering with mutations but deliberately
 * does not acquire the publication lease. Renderer gestures use it at
 * pointer-down, then release the FIFO immediately instead of blocking an
 * in-progress drag.
 */
export function readProjectMutationReservation<T>(operation: () => Promise<T>): Promise<T> {
  return enqueueHistoryOperation(operation);
}

export type TransformReservationState = {
  status: HistoryStatus;
  structure: ModelStructureResult;
};

type TransformReservationRuntime = Pick<SlicerRuntime, 'getHistoryStatus' | 'getModelStructure'>;

/** Capture the two native facts that a renderer gesture can retain while idle. */
export function captureTransformReservationState(runtime: TransformReservationRuntime): Promise<TransformReservationState> {
  return readProjectMutationReservation(() => readTransformReservationState(runtime));
}

/** The release caller is already inside the FIFO; do not enqueue this read again. */
export async function readTransformReservationState(runtime: TransformReservationRuntime): Promise<TransformReservationState> {
  return { status: await runtime.getHistoryStatus(), structure: await runtime.getModelStructure() };
}

/**
 * Run a native project mutation that owns its own atomic history command.
 *
 * Most edits use runProjectHistoryMutation because the Worker transaction
 * itself is coordinated here. A few native commands (currently Prime Tower
 * placement) expose one atomic command instead; they still must use this same
 * FIFO and hold the publication fence until their renderer projection is
 * complete.
 */
export function runProjectMutationOperation<T>(operation: () => Promise<T>): Promise<T> {
  return enqueueHistoryOperation(async () => {
    const lease = acquireProjectMutationLease();
    try {
      return await operation();
    } finally {
      lease.release();
    }
  });
}

type HistoryTransactionRuntime = HistoryMutationRuntime & {
  runProjectHistoryTransaction: SlicerRuntime['runProjectHistoryTransaction'];
};

/** Central low-level project transaction entrypoint. */
export function executeProjectHistoryTransaction<T extends MutationResponse>(
  runtime: HistoryTransactionRuntime,
  label: string,
  beforeContext: HistoryContext | (() => HistoryContext),
  mutation: (transactionId: string) => Promise<T>,
  afterContext: HistoryContext | (() => HistoryContext | Promise<HistoryContext>),
  publish?: (result: T, status: HistoryStatus | null) => Promise<void> | void,
  onSynchronousError?: (error: unknown) => void,
  reconcileOnFailure?: () => Promise<void> | void,
  /** Runs under the shared FIFO immediately before the native transaction is
   * opened.  It is used by renderer-local gestures to reject a reservation
   * invalidated by an intervening Worker mutation without ever opening a
   * transaction for their obsolete draft. */
  preflight?: () => Promise<void> | void,
): Promise<HistoryMutationResult<T>> {
  return enqueueHistoryOperation(async () => {
    const lease = acquireProjectMutationLease();
    try {
      let response: HistoryMutationResult<T>;
      let nativeTransaction: Promise<HistoryMutationResult<T>>;
      try {
        if (preflight) await preflight();
        const resolvedBeforeContext = typeof beforeContext === 'function' ? beforeContext() : beforeContext;
        nativeTransaction = runtime.runProjectHistoryTransaction(
          label,
          'project',
          resolvedBeforeContext,
          mutation,
          afterContext,
        ) as unknown as Promise<HistoryMutationResult<T>>;
      } catch (error) {
        // A synchronous bridge-start failure means no native transaction was
        // entered, so there is no revision window to fence. Release now so
        // callers that handle the start failure synchronously cannot observe
        // a leaked pending state; the best-effort projection refresh follows.
        try { onSynchronousError?.(error); } catch { /* reporting cannot break cleanup */ }
        lease.release();
        await reconcileOnFailure?.();
        const status = await runtime.getHistoryStatus().catch(() => null);
        if (status) projectHistoryStatus(status);
        await refreshFilamentSession(runtime, undefined, lease);
        return {
          result: { ok: false, error: error instanceof Error ? error.message : String(error) } as T,
          status,
        };
      }
      try {
        response = await nativeTransaction;
      } catch (error) {
        await reconcileOnFailure?.();
        const status = await runtime.getHistoryStatus().catch(() => null);
        if (status) projectHistoryStatus(status);
        await refreshFilamentSession(runtime, undefined, lease);
        return {
          result: { ok: false, error: error instanceof Error ? error.message : String(error) } as T,
          status,
        };
      }
      if (response.status) projectHistoryStatus(response.status);
      await refreshFilamentSession(runtime, undefined, lease);
      await publish?.(response.result, response.status);
      return response;
    } finally {
      lease.release();
    }
  });
}

/** Run one project mutation through the Worker-owned history transaction. */
export async function runProjectHistoryMutation<T extends MutationResponse>(
  runtime: HistoryMutationRuntime,
  label: string,
  mutation: () => Promise<T>,
  sceneInteraction?: SceneInteractionController | null,
  options: ProjectHistoryMutationOptions<T> = {},
): Promise<HistoryMutationResult<T>> {
  return executeProjectHistoryTransaction(
    runtime,
    label,
    () => historyContextForStructure(sceneInteraction),
    async () => {
      const result = await mutation();
      if (result.ok !== true) throw new Error(result.error ?? `${label} failed`);
      return result;
    },
    async () => {
      let context = historyContextForStructure(sceneInteraction);
      const structure = await runtime.getModelStructure().catch(() => null);
      if (structure) context = projectContextOntoStructure(context, structure);
      const plateSession = await runtime.getPlateSessionSnapshot().catch(() => null);
      if (plateSession?.ok) context = { ...context, activePlateId: plateSession.currentPlateId };
      return context;
    },
    options.publish,
  );
}

export type HistoryRestoreAction = 'undo' | 'redo' | { jump: string; direction: 'undo' | 'redo' };

/** Central restore entrypoint; model/UI publication runs under the same fence. */
export function restoreProjectHistory(
  runtime: Pick<SlicerRuntime, 'undoHistory' | 'redoHistory' | 'jumpHistory'> &
    Pick<SlicerRuntime, 'getFilamentSessionSnapshot' | 'getHistoryStatus'>,
  action: HistoryRestoreAction,
  publish?: (result: Extract<import('@slicer/client').RestoreResult, { ok: true }>) => Promise<void> | void,
): Promise<import('@slicer/client').RestoreResult> {
  return enqueueHistoryOperation(async () => {
    const lease = acquireProjectMutationLease();
    try {
      let result: import('@slicer/client').RestoreResult;
      try {
        result = action === 'undo' ? await runtime.undoHistory()
          : action === 'redo' ? await runtime.redoHistory()
            : await runtime.jumpHistory(action.jump, action.direction);
      } catch (error) {
        const status = await runtime.getHistoryStatus().catch(() => null);
        if (status) projectHistoryStatus(status);
        await refreshFilamentSession(runtime, undefined, lease);
        return { ok: false, error: { code: 'unknown', message: error instanceof Error ? error.message : String(error), retryable: true }, status: status ?? undefined };
      }
      if (result.status) projectHistoryStatus(result.status);
      await refreshFilamentSession(runtime, undefined, lease);
      if (result.ok) {
        await publish?.(result);
      }
      return result;
    } finally {
      lease.release();
    }
  });
}

export async function readProjectHistoryStatus(
  runtime: Pick<SlicerRuntime, 'getHistoryStatus'>,
  clearLegacyReasons = false,
): Promise<HistoryStatus | null> {
  return enqueueProjectMutationOperation(async () => {
    try {
      const status = await runtime.getHistoryStatus();
      const projected = projectHistoryStatus(status);
      if (clearLegacyReasons) useProjectStore.getState().setProject({ dirtyReasons: [] });
      return projected;
    } catch { return null; }
  });
}

export async function markProjectHistorySaved(
  runtime: Pick<SlicerRuntime, 'markHistorySaved'>,
  context: HistoryContext,
): Promise<HistoryStatus> {
  return enqueueHistoryOperation(async () => {
    const lease = acquireProjectMutationLease();
    try {
      const status = await runtime.markHistorySaved(context);
      return projectHistoryStatus(status);
    } finally { lease.release(); }
  });
}

export async function resetProjectHistory(
  runtime: Pick<SlicerRuntime, 'resetHistory' | 'getFilamentSessionSnapshot'>,
  context: HistoryContext,
): Promise<HistoryStatus> {
  return enqueueHistoryOperation(async () => {
    const lease = acquireProjectMutationLease();
    try {
      const status = await runtime.resetHistory(context);
      projectHistoryStatus(status);
      await refreshFilamentSession(runtime, undefined, lease);
      return status;
    } finally { lease.release(); }
  });
}

export async function recordProjectHistoryContext(
  runtime: Pick<SlicerRuntime, 'recordHistoryContext'>,
  label: string,
  context: HistoryContext,
): Promise<HistoryStatus> {
  return enqueueHistoryOperation(async () => {
    const lease = acquireProjectMutationLease();
    try {
      const status = await runtime.recordHistoryContext(label, context);
      return projectHistoryStatus(status);
    } finally { lease.release(); }
  });
}

/** Read and project the Worker's current checkpoint state. */
export async function syncHistoryStatus(runtime: Pick<SlicerRuntime, 'getHistoryStatus'>): Promise<HistoryStatus | null> {
  return enqueueProjectMutationOperation(async () => {
    try {
      const status = await runtime.getHistoryStatus();
      return projectHistoryStatus(status);
    } catch {
      return null;
    }
  });
}
