import type { HistoryStatus } from '@slicer/client';
import { useHistoryNavigationStore } from '../stores/useHistoryNavigationStore';
import { useProjectStore } from '../stores/useProjectStore';

/**
 * Project one Worker receipt into every UI consumer that derives from history.
 * A receipt with an older native revision is never allowed to roll toolbar,
 * menu, or canonical dirty state back after a later FIFO operation published.
 */
export function projectHistoryStatus(status: HistoryStatus): HistoryStatus {
  const current = useHistoryNavigationStore.getState().status;
  if (current && status.revision < current.revision) return current;
  useHistoryNavigationStore.getState().setStatus(status);
  useProjectStore.getState().setProject({ dirty: status.dirty, dirtyReasons: [] });
  return status;
}
