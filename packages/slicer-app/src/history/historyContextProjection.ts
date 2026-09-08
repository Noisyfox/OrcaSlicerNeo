import type { HistoryContext } from '@slicer/client';

export interface PendingHistoryContext {
  context: HistoryContext;
  historyRevision: number;
  modelRevision: number;
  expectedObjectCount: number;
}
/**
 * A model revision is complete only after the loader has published the mesh
 * replacement for that same revision.  In particular, an old non-empty mesh
 * must never satisfy a restore while the new Worker model is still loading.
 * Empty baselines are valid and become ready when the loader publishes an
 * empty replacement with the matching revision.
 */
export function isHistoryContextProjectionReady(
  pending: PendingHistoryContext | null,
  currentHistoryRevision: number,
  currentModelRevision: number,
  meshRevision: number,
  meshCount: number,
): boolean {
  if (!pending || pending.historyRevision !== currentHistoryRevision ||
      pending.modelRevision !== currentModelRevision || pending.modelRevision !== meshRevision)
    return false;
  return pending.expectedObjectCount === 0 ? meshCount === 0 : meshCount > 0;
}
