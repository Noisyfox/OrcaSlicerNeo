import { create } from 'zustand';

/** Shared lifecycle state for an atomic Worker history restore. */
export type HistoryRestorePhase = 'idle' | 'cancelling-slice' | 'restoring';

interface HistoryRestoreState {
  phase: HistoryRestorePhase;
  /** Monotonic renderer token; async mesh/structure results carry this value. */
  revision: number;
  error: string | null;
  snapshotSuppressed: boolean;
  setPhase: (phase: HistoryRestorePhase) => void;
  advanceRevision: () => number;
  setError: (error: string | null) => void;
  setSnapshotSuppressed: (suppressed: boolean) => void;
  consumeSnapshotSuppression: () => boolean;
  reset: () => void;
}

export const useHistoryRestoreStore = create<HistoryRestoreState>((set, get) => ({
  phase: 'idle',
  revision: 0,
  error: null,
  snapshotSuppressed: false,
  setPhase: (phase) => set({ phase }),
  advanceRevision: () => {
    const revision = get().revision + 1;
    set({ revision });
    return revision;
  },
  setError: (error) => set({ error }),
  setSnapshotSuppressed: (snapshotSuppressed) => set({ snapshotSuppressed }),
  consumeSnapshotSuppression: () => {
    if (!get().snapshotSuppressed) return false;
    set({ snapshotSuppressed: false });
    return true;
  },
  reset: () => set({ phase: 'idle', error: null, snapshotSuppressed: false }),
}));
