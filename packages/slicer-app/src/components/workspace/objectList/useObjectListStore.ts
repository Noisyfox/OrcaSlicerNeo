import type { HeightRangeBounds, HeightRangeRow } from '@slicer/client';
import { create } from 'zustand';
import type { ModelObjectStructure } from '@slicer/client';
import { EMPTY_PROJECTION, type HighlightLevel, type SelectionProjection } from './projection';

export interface HeightRangeSelection {
  objectId: number;
  instanceId?: number;
  bounds: HeightRangeBounds[] | 'all';
}
export function sameBounds(a: HeightRangeBounds, b: HeightRangeBounds) {
  return a.min === b.min && a.max === b.max;
}
export function selectedHeightRanges(object: ModelObjectStructure, selection: HeightRangeSelection): HeightRangeRow[] {
  const rows = object.heightRanges ?? [];
  const bounds = selection.bounds;
  return bounds === 'all' ? rows : rows.filter(row => bounds.some(key => sameBounds(row, key)));
}

interface ObjectListState {
  heightRangeSelection: HeightRangeSelection | null;
  heightRangeFocus: 'min' | 'max' | null;
  rangeClipboard: { generation: number; rows: HeightRangeRow[] } | null;
  selectRanges: (selection: HeightRangeSelection | null) => void;
  focusRange: (field: 'min' | 'max' | null) => void;
  copyRanges: (generation: number, rows: HeightRangeRow[]) => void;
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
  heightRangeSelection: null, heightRangeFocus: null, rangeClipboard: null,
  selectRanges: (heightRangeSelection) => set(s => ({
    heightRangeSelection, heightRangeFocus: null,
    expanded: heightRangeSelection ? { ...s.expanded, [heightRangeSelection.objectId]: true } : s.expanded,
  })),
  focusRange: (heightRangeFocus) => set({ heightRangeFocus }),
  copyRanges: (generation, rows) => set({ rangeClipboard: { generation, rows } }),
  setStructure: (structure) => set(s => {
    const selection = s.heightRangeSelection;
    const object = selection && structure.find(o => o.id === selection.objectId);
    return !selection || (object && selectedHeightRanges(object, selection).length)
      ? { structure } : { structure, heightRangeSelection: null, heightRangeFocus: null };
  }),
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
    heightRangeSelection: null, heightRangeFocus: null, rangeClipboard: null,
    structure: [],
    loaded: false,
    expanded: {},
    highlightLevel: {},
    collapsedInstances: {},
    projection: EMPTY_PROJECTION,
  }),
}));
