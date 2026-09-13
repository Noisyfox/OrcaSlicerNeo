import { useProjectStore } from '../stores/useProjectStore';

/**
 * Shared application fence for any operation that can advance the native
 * project/session revision.  The lease is intentionally opaque and
 * idempotent: ownership is never represented by caller boolean flags.
 */
export interface ProjectMutationLease {
  release(): void;
}

type QueuedOperation = {
  operation: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};
let operationBusy = false;
const operationQueue: QueuedOperation[] = [];

/** One FIFO shared by project history and filament mutations. */
export function enqueueProjectMutationOperation<T>(operation: () => Promise<T>): Promise<T> {
  const task = new Promise<T>((resolve, reject) => {
    operationQueue.push({ operation: operation as () => Promise<unknown>, resolve: resolve as (value: unknown) => void, reject });
  });
  drainOperations();
  return task;
}

function drainOperations(): void {
  if (operationBusy) return;
  const next = operationQueue.shift();
  if (!next) return;
  operationBusy = true;
  let task: Promise<unknown>;
  try { task = next.operation(); } catch (error) { task = Promise.reject(error); }
  void task.then(next.resolve, next.reject).then(() => {
    operationBusy = false;
    drainOperations();
  }, () => {
    operationBusy = false;
    drainOperations();
  });
}

export function acquireProjectMutationLease(): ProjectMutationLease {
  useProjectStore.getState().beginProjectMutation();
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      useProjectStore.getState().endProjectMutation();
    },
  };
}
