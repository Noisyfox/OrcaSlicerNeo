import { create } from 'zustand';

/** Shared lifecycle state for an atomic Worker history restore. */
export type HistoryRestorePhase = 'idle' | 'cancelling-slice' | 'restoring';

interface HistoryRestoreState {
  phase: HistoryRestorePhase;
  /** Monotonic renderer token; async mesh/structure results carry this value. */
  revision: number;
  error: string | null;
  setPhase: (phase: HistoryRestorePhase) => void;
  advanceRevision: () => number;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useHistoryRestoreStore = create<HistoryRestoreState>((set, get) => ({
  phase: 'idle',
  revision: 0,
  error: null,
  setPhase: (phase) => set({ phase }),
  advanceRevision: () => {
    const revision = get().revision + 1;
    set({ revision });
    return revision;
  },
  setError: (error) => set({ error }),
  reset: () => set({ phase: 'idle', error: null }),
}));
