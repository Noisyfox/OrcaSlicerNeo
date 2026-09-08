import type { SliceStatus } from '../../stores/useSlicerStore';

export interface WorkspaceSliceCoordinator {
  /** Ensure the current model has a slice, joining this coordinator's task. */
  ensureSlice(): Promise<void>;
  /** Request the Preview tab and then ensure the current model has a slice. */
  requestPreviewSlice(): Promise<void>;
  /** Cancel an active Worker slice and await its terminal cleanup. */
  cancelAndWait(): Promise<void>;
}

interface WorkspaceSliceCoordinatorDeps {
  isModelLoaded: () => boolean;
  getStatus: () => SliceStatus;
  slice: () => Promise<void>;
  requestPreview: () => void;
  cancel?: () => Promise<unknown>;
}

/**
 * Coordinate every Workspace-owned route into slicing.
 *
 * `sliceModel` performs asynchronous transform synchronization before it sets
 * the store status to `slicing`. The local promise is therefore assigned
 * before the call is allowed to yield, preventing two callers from entering
 * that gap and starting duplicate slices.
 */
export function createWorkspaceSliceCoordinator({
  isModelLoaded,
  getStatus,
  slice,
  requestPreview,
  cancel,
}: WorkspaceSliceCoordinatorDeps): WorkspaceSliceCoordinator {
  let inFlight: Promise<void> | null = null;

  const ensureSlice = (): Promise<void> => {
    if (!isModelLoaded()) return Promise.resolve();

    const status = getStatus();
    if (status === 'done' || status === 'slicing') {
      return inFlight ?? Promise.resolve();
    }
    if (inFlight) return inFlight;

    const task = Promise.resolve().then(() => slice());
    inFlight = task.finally(() => {
      if (inFlight === joinedTask) inFlight = null;
    });
    const joinedTask = inFlight;
    return joinedTask;
  };

  return {
    ensureSlice,
    requestPreviewSlice: () => {
      requestPreview();
      return ensureSlice();
    },
    cancelAndWait: async () => {
      const task = inFlight;
      // Keep the cancellation request even when the local promise has not
      // been assigned yet; the store's slicing state is the authoritative
      // signal and the Worker must receive the cancel before restore starts.
      await Promise.allSettled([task ?? Promise.resolve(), cancel ? cancel() : Promise.resolve()]);
    },
  };
}
