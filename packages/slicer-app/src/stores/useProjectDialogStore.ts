import { create } from 'zustand';
/** Locks scene-changing entry points for the lifetime of a project modal. */
export const useProjectDialogStore = create<{ open: boolean }>(() => ({ open: false }));
