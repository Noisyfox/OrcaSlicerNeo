import { create } from 'zustand';
/** Live Device selection, separate from the ephemeral print-dialog target. */
export const useDeviceSelectionStore = create<{
  currentPrinterId: string | null;
  requestedPrinterId: string | null;
  requestVersion: number;
  setCurrent(id: string | null): void;
  showPrinter(id: string): void;
}>(set => ({
  currentPrinterId: null, requestedPrinterId: null, requestVersion: 0,
  setCurrent: currentPrinterId => set({ currentPrinterId }),
  showPrinter: requestedPrinterId => set(state => ({ requestedPrinterId, requestVersion: state.requestVersion + 1 })),
}));
