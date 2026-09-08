import { create } from 'zustand';
import type { HistoryStatus } from '@slicer/client';

/** Latest Worker-owned status projected for shared navigation controls. */
interface HistoryNavigationState {
  status: HistoryStatus | null;
  setStatus: (status: HistoryStatus | null) => void;
  reset: () => void;
}

export const useHistoryNavigationStore = create<HistoryNavigationState>((set) => ({
  status: null,
  setStatus: (status) => set({ status }),
  reset: () => set({ status: null }),
}));
