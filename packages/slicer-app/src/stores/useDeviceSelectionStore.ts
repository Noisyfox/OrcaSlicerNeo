import { create } from 'zustand';
/** Device selection and page navigation have separate callers and lifetimes. */
export const useDeviceSelectionStore = create<{
  currentPrinterId: string | null;
  requestedPrinterId: string | null;
  selectionRequestVersion: number;
  navigationRequestVersion: number;
  setCurrent(id: string | null): void;
  selectPrinter(id: string): void;
  showPrinter(id: string): void;
}>(set => ({
  currentPrinterId: null, requestedPrinterId: null, selectionRequestVersion: 0, navigationRequestVersion: 0,
  setCurrent: currentPrinterId => set({ currentPrinterId }),
  selectPrinter: requestedPrinterId => set(state => ({ requestedPrinterId, currentPrinterId: requestedPrinterId,
    selectionRequestVersion: state.selectionRequestVersion + 1 })),
  showPrinter: requestedPrinterId => set(state => ({ requestedPrinterId, currentPrinterId: requestedPrinterId,
    selectionRequestVersion: state.selectionRequestVersion + 1, navigationRequestVersion: state.navigationRequestVersion + 1 })),
}));
