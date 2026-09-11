import { create } from 'zustand';
import type {
  FilamentAssignmentRequest,
  FilamentCommandRequest,
  FilamentMutationResultOrError,
  FilamentSessionSnapshot,
  FilamentSessionSnapshotResult,
  FilamentSlotColourRequest,
  FilamentSlotDeleteRequest,
  FilamentSlotMergeRequest,
  FilamentSlotPresetRequest,
  SlicerClient,
} from '@slicer/client';
import { applyFilamentMutationResult } from './plateResultLifecycle';
import { enqueueProjectMutationOperation, type ProjectMutationLease } from '../history/projectMutationGate';
import { projectHistoryStatus } from '../history/projectHistoryStatus';

/**
 * UI state for the material rack. `snapshot` is always the last complete
 * Worker projection; commands never edit it optimistically. This keeps the
 * native session as the only source of truth while still allowing React to
 * render pending and rejected command state.
 */
interface FilamentSessionState {
  snapshot: FilamentSessionSnapshot | null;
  pendingKind: string | null;
  rejected: string | null;
  load: (runtime: SlicerClient) => Promise<FilamentSessionSnapshotResult>;
  refresh: (runtime: Pick<SlicerClient, 'getFilamentSessionSnapshot'>, isCurrent?: () => boolean, lease?: ProjectMutationLease) => Promise<FilamentSessionSnapshotResult>;
  run: (runtime: SlicerClient, command: () => Promise<FilamentMutationResultOrError>) => Promise<FilamentMutationResultOrError>;
  clearRejected: () => void;
  reset: () => void;
}

let pendingFilamentOperations = 0;

function isSnapshot(result: FilamentSessionSnapshotResult): result is FilamentSessionSnapshot {
  return result.ok === true && Array.isArray(result.slots);
}

async function readFilamentSnapshot(
  runtime: Pick<SlicerClient, 'getFilamentSessionSnapshot'>,
  set: (state: Partial<FilamentSessionState>) => void,
  isCurrent: () => boolean,
): Promise<FilamentSessionSnapshotResult> {
  try {
    const result = await runtime.getFilamentSessionSnapshot();
    if (!isCurrent()) return result;
    if (isSnapshot(result)) set({ snapshot: result, rejected: null });
    else set({ rejected: result.error });
    return result;
  } catch (error) {
    const result = {
      ok: false as const,
      version: 1 as const,
      error: error instanceof Error ? error.message : String(error),
      errorCode: 'runtime_failure',
    };
    if (isCurrent()) set({ rejected: result.error });
    return result;
  }
}

export const useFilamentSessionStore = create<FilamentSessionState>((set) => ({
  snapshot: null,
  pendingKind: null,
  rejected: null,
  load: (runtime): Promise<FilamentSessionSnapshotResult> => enqueueProjectMutationOperation(
    () => readFilamentSnapshot(runtime, set, () => true),
  ),
  refresh: (runtime, isCurrent = () => true, lease): Promise<FilamentSessionSnapshotResult> =>
    lease ? readFilamentSnapshot(runtime, set, isCurrent) : enqueueProjectMutationOperation(
      () => readFilamentSnapshot(runtime, set, isCurrent),
    ),
  run: async (runtime, command) => {
    pendingFilamentOperations += 1;
    set({ pendingKind: 'mutation', rejected: null });
    return enqueueProjectMutationOperation(async () => {
      try {
        const result = await command();
        if (result.ok) {
          // The native command and this receipt share one commit. Project it
          // before any dependent session/result publication; do not issue a
          // competing history-status read from this FIFO operation.
          projectHistoryStatus(result.result.historyStatus);
          set({ snapshot: result.result.snapshot, rejected: null });
          await applyFilamentMutationResult(result.result.mutation, runtime);
        }
        else set({ rejected: result.error });
        return result;
      } catch (error) {
        const rejected = String(error);
        set({ rejected });
        return { ok: false, version: 1, error: rejected, errorCode: 'runtime_failure' };
      } finally {
        pendingFilamentOperations -= 1;
        if (pendingFilamentOperations === 0) set({ pendingKind: null });
      }
    });
  },
  clearRejected: () => set({ rejected: null }),
  reset: () => set({ snapshot: null, pendingKind: null, rejected: null }),
}));

/** Refresh the complete Worker projection after a model/project replacement.
 * Callers may fence publication when a newer history restore supersedes the
 * request. */
export async function refreshFilamentSession(
  runtime: Pick<SlicerClient, 'getFilamentSessionSnapshot'>,
  isCurrent?: () => boolean,
  lease?: ProjectMutationLease,
): Promise<FilamentSessionSnapshotResult> {
  return useFilamentSessionStore.getState().refresh(runtime, isCurrent, lease);
}

export type FilamentMutationRequest =
  | FilamentSlotPresetRequest
  | FilamentSlotColourRequest
  | FilamentCommandRequest
  | FilamentSlotDeleteRequest
  | FilamentSlotMergeRequest
  | FilamentAssignmentRequest;
