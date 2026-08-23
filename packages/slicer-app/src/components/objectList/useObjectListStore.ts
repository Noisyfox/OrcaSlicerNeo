import { create } from 'zustand';
import type { ModelObjectStructure } from '@slicer/client';
import { EMPTY_PROJECTION, type SelectionProjection } from './projection';

interface ObjectListState {
  /** Current model structure (from getModelStructure), keyed at the store level. */
  structure: ModelObjectStructure[];
  loaded: boolean;
  /** Object-ID -> row expansion (object/part/instance tree). */
  expanded: Record<number, boolean>;
  /** Read-only projection of the viewport selection onto structure IDs. */
  projection: SelectionProjection;
  setStructure: (structure: ModelObjectStructure[]) => void;
  setLoaded: (loaded: boolean) => void;
  toggleExpanded: (objectId: number) => void;
  setProjection: (projection: SelectionProjection) => void;
  clear: () => void;
}

export const useObjectListStore = create<ObjectListState>((set) => ({
  structure: [],
  loaded: false,
  expanded: {},
  projection: EMPTY_PROJECTION,
  setStructure: (structure) => set({ structure }),
  setLoaded: (loaded) => set({ loaded }),
  toggleExpanded: (objectId) => set((s) => ({
    expanded: { ...s.expanded, [objectId]: !s.expanded[objectId] },
  })),
  setProjection: (projection) => set({ projection }),
  clear: () => set({
    structure: [],
    loaded: false,
    expanded: {},
    projection: EMPTY_PROJECTION,
  }),
}));
