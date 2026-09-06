import { create } from 'zustand';
import type { PlateSessionSnapshot } from '@slicer/client';

/**
 * The renderer's read-only projection of the WASM-owned plate session.
 *
 * This store intentionally contains no layout or membership logic.  Runtime
 * responses replace the complete snapshot atomically; viewport components
 * only use the returned origins and state flags.
 */
interface PlateSessionState {
  snapshot: PlateSessionSnapshot | null;
  setSnapshot: (snapshot: PlateSessionSnapshot | null) => void;
  reset: () => void;
}

export const usePlateSessionStore = create<PlateSessionState>((set) => ({
  snapshot: null,
  setSnapshot: (snapshot) => set({ snapshot }),
  reset: () => set({ snapshot: null }),
}));
