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
    else set({ snapshot: null, rejected: result.error });
    return result;
  } catch (error) {
    const result = {
      ok: false as const,
      version: 1 as const,
      error: error instanceof Error ? error.message : String(error),
      errorCode: 'runtime_failure',
    };
    if (isCurrent()) set({ snapshot: null, rejected: result.error });
    return result;
  }
}

export const useFilamentSessionStore = create<FilamentSessionState>((set) => ({
  snapshot: null,
  pendingKind: null,
  rejected: null,
  load: (runtime): Promise<FilamentSessionSnapshotResult> => readFilamentSnapshot(runtime, set, () => true),
  refresh: (runtime, isCurrent = () => true): Promise<FilamentSessionSnapshotResult> => readFilamentSnapshot(runtime, set, isCurrent),
  run: async (runtime, command) => {
    set({ pendingKind: 'mutation', rejected: null });
    try {
      const result = await command();
      if (result.ok) {
        set({ snapshot: result.result.snapshot, rejected: null });
        await applyFilamentMutationResult(result.result.mutation, runtime);
        set({ pendingKind: null });
      }
      else set({ pendingKind: null, rejected: result.error });
      return result;
    } catch (error) {
      const rejected = String(error);
      set({ pendingKind: null, rejected });
      return { ok: false, version: 1, error: rejected, errorCode: 'runtime_failure' };
    }
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
