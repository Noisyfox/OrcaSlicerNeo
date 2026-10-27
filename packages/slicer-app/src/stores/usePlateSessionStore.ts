import { create } from 'zustand';
import type { PlateSessionSnapshot } from '@slicer/client';
import { useNotificationStore } from './useNotificationStore';

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
  setSnapshot: (snapshot) => set(state => {
    const notifications = useNotificationStore.getState();
    if (!snapshot) notifications.reset();
    else {
      const changed = snapshot.plates.filter(plate => state.snapshot &&
        snapshot.inputRevisions?.[plate.plateId] !== state.snapshot.inputRevisions?.[plate.plateId]).map(plate => plate.plateId);
      notifications.invalidate(changed);
      notifications.reconcileOwners(snapshot.plates.map(p => p.plateId), snapshot.instances.map(i => String(i.objectId)));
    }
    return { snapshot };
  }),
  reset: () => { useNotificationStore.getState().reset(); set({ snapshot: null }); },
}));
