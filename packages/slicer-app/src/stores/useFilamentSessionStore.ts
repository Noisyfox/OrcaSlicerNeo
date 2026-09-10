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
  refresh: (runtime: SlicerClient, isCurrent?: () => boolean) => Promise<FilamentSessionSnapshotResult>;
  run: (runtime: SlicerClient, command: () => Promise<FilamentMutationResultOrError>) => Promise<FilamentMutationResultOrError>;
  clearRejected: () => void;
  reset: () => void;
}

// Model/project mutations can advance the native history revision without
// changing the renderer's React projection synchronously.  Keep every
// filament read and write on one FIFO so a command can never overtake the
// refresh that fences such a mutation.
let filamentOperationTail: Promise<void> = Promise.resolve();
let pendingFilamentOperations = 0;

function enqueueFilamentOperation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = filamentOperationTail;
  let release!: () => void;
  filamentOperationTail = new Promise<void>((resolve) => { release = resolve; });
  return previous
    .catch(() => undefined)
    .then(operation)
    .finally(release);
}

function isSnapshot(result: FilamentSessionSnapshotResult): result is FilamentSessionSnapshot {
  return result.ok === true && Array.isArray(result.slots);
}

async function readFilamentSnapshot(
  runtime: SlicerClient,
  set: (state: Partial<FilamentSessionState>) => void,
  isCurrent: () => boolean,
): Promise<FilamentSessionSnapshotResult> {
  if (!runtime || typeof runtime.getFilamentSessionSnapshot !== 'function') {
    const result = { ok: false as const, version: 1 as const, error: 'filament runtime unavailable', errorCode: 'runtime_unavailable' };
    if (isCurrent()) set({ snapshot: null, rejected: result.error });
    return result;
  }
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
  load: (runtime): Promise<FilamentSessionSnapshotResult> => enqueueFilamentOperation(
    () => readFilamentSnapshot(runtime, set, () => true),
  ),
  refresh: (runtime, isCurrent = () => true): Promise<FilamentSessionSnapshotResult> => enqueueFilamentOperation(
    () => readFilamentSnapshot(runtime, set, isCurrent),
  ),
  run: async (runtime, command) => {
    pendingFilamentOperations += 1;
    set({ pendingKind: 'mutation', rejected: null });
    return enqueueFilamentOperation(async () => {
      try {
        const result = await command();
        if (result.ok) {
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
 * request. An unavailable legacy runtime is treated as a no-op by lifecycle
 * callers; the live native session remains authoritative whenever present. */
export async function refreshFilamentSession(
  runtime: Pick<SlicerClient, 'getFilamentSessionSnapshot'> | undefined,
  isCurrent?: () => boolean,
): Promise<FilamentSessionSnapshotResult | null> {
  if (!runtime || typeof runtime.getFilamentSessionSnapshot !== 'function') return null;
  return useFilamentSessionStore.getState().refresh(runtime as SlicerClient, isCurrent);
}

export type FilamentMutationRequest =
  | FilamentSlotPresetRequest
  | FilamentSlotColourRequest
  | FilamentCommandRequest
  | FilamentSlotDeleteRequest
  | FilamentSlotMergeRequest
  | FilamentAssignmentRequest;
