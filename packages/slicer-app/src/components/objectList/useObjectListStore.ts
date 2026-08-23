import { create } from 'zustand';
import type { ModelObjectStructure } from '@slicer/client';
import { EMPTY_PROJECTION, type HighlightLevel, type SelectionProjection } from './projection';

interface ObjectListState {
  /** Current model structure (from getModelStructure), keyed at the store level. */
  structure: ModelObjectStructure[];
  loaded: boolean;
  /** Object-ID -> row expansion (object/part/instance tree). */
  expanded: Record<number, boolean>;
  /** Object index -> the row kind that last drove selection (highlight granularity). */
  highlightLevel: Record<number, HighlightLevel>;
  /** Object index -> whether its Instances group is collapsed (default: expanded). */
  collapsedInstances: Record<number, boolean>;
  /** Read-only projection of the viewport selection onto structure IDs. */
  projection: SelectionProjection;
  setStructure: (structure: ModelObjectStructure[]) => void;
  setLoaded: (loaded: boolean) => void;
  toggleExpanded: (objectId: number) => void;
  toggleInstancesCollapsed: (objectId: number) => void;
  setHighlightLevel: (objectId: number, level: HighlightLevel) => void;
  setProjection: (projection: SelectionProjection) => void;
  clear: () => void;
}

export const useObjectListStore = create<ObjectListState>((set) => ({
  structure: [],
  loaded: false,
  expanded: {},
  highlightLevel: {},
  collapsedInstances: {},
  projection: EMPTY_PROJECTION,
  setStructure: (structure) => set({ structure }),
  setLoaded: (loaded) => set({ loaded }),
  toggleExpanded: (objectId) => set((s) => ({
    expanded: { ...s.expanded, [objectId]: !s.expanded[objectId] },
  })),
  toggleInstancesCollapsed: (objectId) => set((s) => ({
    collapsedInstances: {
      ...s.collapsedInstances,
      [objectId]: !s.collapsedInstances[objectId],
    },
  })),
  setHighlightLevel: (objectId, level) => set((s) => ({
    highlightLevel: { ...s.highlightLevel, [objectId]: level },
  })),
  setProjection: (projection) => set({ projection }),
  clear: () => set({
    structure: [],
    loaded: false,
    expanded: {},
    highlightLevel: {},
    collapsedInstances: {},
    projection: EMPTY_PROJECTION,
  }),
}));
