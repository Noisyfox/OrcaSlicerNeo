import { create } from 'zustand';
/** Locks scene-changing entry points for the lifetime of a print modal. */
export const usePrintDialogStore = create<{ open: boolean }>(() => ({ open: false }));
