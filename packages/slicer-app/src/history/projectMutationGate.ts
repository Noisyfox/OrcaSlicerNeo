import { useProjectStore } from '../stores/useProjectStore';
import { useArrangementStore } from '../stores/useArrangementStore';
import { coordinatePaintingProjectOperation } from '../components/workspace/viewport/gizmo/painting/projectCommands';

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
/** Only the caller holding this identity may enter during an exclusive edit. */
export interface ProjectMutationAdmission { readonly token: symbol }
let exclusiveAdmission: ProjectMutationAdmission | null = null;
let operationBusy = false;
const operationQueue: QueuedOperation[] = [];

/** One FIFO shared by project history and filament mutations. */
export function enqueueProjectMutationOperation<T>(operation: () => Promise<T>, admission?: ProjectMutationAdmission): Promise<T> {
  if (exclusiveAdmission) {
    if (admission !== exclusiveAdmission) return Promise.reject(new Error('mesh_boolean_busy'));
    return enqueueOperation(operation);
  }
  return coordinatePaintingProjectOperation(operation, enqueuePaintingOperation);
}

/** Painting already owns admission and its own lane; it joins the same FIFO
 * without recursively requesting project-command admission. */
export function enqueuePaintingOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (exclusiveAdmission) return Promise.reject(new Error('mesh_boolean_busy'));
  if (useArrangementStore.getState().active) return Promise.reject(new Error('arrangement_busy'));
  return enqueueOperation(operation);
}

/** Read-only reservations preserve publication ordering without edit admission,
 * a mutation lease, or changing the active painting session. */
export function enqueueProjectReadOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (exclusiveAdmission) return Promise.reject(new Error('mesh_boolean_busy'));
  return enqueueOperation(operation);
}

/** Reserve an idle lane immediately; never queue a Boolean behind another edit. */
export async function runExclusiveProjectOperation<T>(operation: (admission: ProjectMutationAdmission) => Promise<T>): Promise<T> {
  if (exclusiveAdmission || operationBusy || operationQueue.length || useArrangementStore.getState().active ||
      useProjectStore.getState().projectMutationPendingCount) throw new Error('project_busy');
  const admission = Object.freeze({ token: Symbol('mesh-boolean') });
  exclusiveAdmission = admission;
  const lease = acquireProjectMutationLease();
  try { return await operation(admission); }
  finally { exclusiveAdmission = null; lease.release(); }
}

function enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
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
