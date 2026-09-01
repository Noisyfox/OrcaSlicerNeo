import { create } from 'zustand';

export type SliceStatus = 'idle' | 'slicing' | 'done' | 'error';
export type PreviewColorScheme = 'feature';

export interface PreviewState {
  visibleLayerStart: number;
  visibleLayerEnd: number;
  activeMoveStart: number;
  activeMoveEnd: number;
  maxMove: number;
  showTravel: boolean;
  dimPreviousLayers: boolean;
  colorScheme: PreviewColorScheme;
  featureVisibility: Record<number, boolean>;
  singleLayer: boolean;
  resultId: number | null;
}

export const DEFAULT_PREVIEW_STATE: PreviewState = {
  visibleLayerStart: 0,
  visibleLayerEnd: 0,
  activeMoveStart: 0,
  activeMoveEnd: 0,
  maxMove: 0,
  showTravel: true,
  dimPreviousLayers: true,
  colorScheme: 'feature',
  featureVisibility: {},
  singleLayer: false,
  resultId: null,
};

interface SlicerState {
  status: SliceStatus;
  progress: number;
  layers: number;
  error: string | null;
  /** A completed slice remains dirty until its G-code is saved by the host. */
  resultExported: boolean;
  layer: number; // scrubber position (0-based, default = max)
  maxLayer: number;
  preview: PreviewState;
  setStatus: (s: SliceStatus) => void;
  setProgress: (p: number) => void;
  setLayers: (n: number) => void;
  setError: (e: string | null) => void;
  setLayer: (n: number) => void;
  setMaxLayer: (n: number) => void;
  setResultExported: (exported: boolean) => void;
  setPreviewBounds: (maxLayer: number, maxMove: number, resultId?: number | null) => void;
  /** Update the inclusive visible range and the active layer's local move bound atomically. */
  setPreviewLayerRange: (range: [number, number], activeLayerMaxMove?: number) => void;
  /** Move the active inspection layer, resetting its local move range atomically. */
  setPreviewLayerEnd: (layer: number, activeLayerMaxMove?: number) => void;
  setPreviewMoveRange: (range: [number, number]) => void;
  setPreviewMoveEnd: (move: number) => void;
  setPreviewShowTravel: (show: boolean) => void;
  setPreviewDimPreviousLayers: (dim: boolean) => void;
  setPreviewColorScheme: (scheme: PreviewColorScheme) => void;
  setPreviewFeatureVisibility: (feature: number, visible: boolean) => void;
  setPreviewSingleLayer: (singleLayer: boolean) => void;
  resetPreviewState: () => void;
  /** Clear every renderer-visible consequence of a completed slice in one state update. */
  invalidateSliceResult: () => void;
}

export const useSlicerStore = create<SlicerState>((set) => ({
  status: 'idle',
  progress: 0,
  layers: 0,
  error: null,
  resultExported: false,
  layer: 0,
  maxLayer: 0,
  preview: DEFAULT_PREVIEW_STATE,
  setStatus: (status) => set({ status }),
  setProgress: (progress) => set({ progress }),
  setLayers: (layers) => set({ layers }),
  setError: (error) => set({ error }),
  setLayer: (layer) => set((state) => ({
    layer,
    preview: { ...state.preview, visibleLayerEnd: layer },
  })),
  setMaxLayer: (maxLayer) => set({ maxLayer }),
  setResultExported: (resultExported) => set({ resultExported }),
  setPreviewBounds: (maxLayer, maxMove, resultId = null) => set((state) => ({
    maxLayer,
    layer: maxLayer,
    preview: {
      ...DEFAULT_PREVIEW_STATE,
      visibleLayerEnd: Math.max(0, maxLayer),
      activeMoveEnd: Math.max(0, maxMove),
      maxMove: Math.max(0, maxMove),
      resultId,
    },
    // Keep this field synchronized for older callers that still read layers.
    layers: Math.max(0, maxLayer + 1),
    error: state.error,
  })),
  setPreviewLayerRange: ([first, last], activeLayerMaxMove) => set((state) => {
    const max = Math.max(0, state.maxLayer);
    const a = Math.max(0, Math.min(max, Math.floor(first)));
    const b = Math.max(a, Math.min(max, Math.floor(last)));
    const layerChanged = b !== state.preview.visibleLayerEnd;
    const maxMove = activeLayerMaxMove === undefined
      ? state.preview.maxMove
      : Math.max(0, Math.floor(activeLayerMaxMove));
    const activeMoveStart = layerChanged ? 0 : Math.min(maxMove, state.preview.activeMoveStart);
    const activeMoveEnd = layerChanged ? maxMove : Math.max(activeMoveStart, Math.min(maxMove, state.preview.activeMoveEnd));
    return {
      layer: b,
      preview: { ...state.preview, visibleLayerStart: a, visibleLayerEnd: b, maxMove, activeMoveStart, activeMoveEnd },
    };
  }),
  setPreviewLayerEnd: (layer, activeLayerMaxMove) => set((state) => {
    const max = Math.max(0, state.maxLayer);
    const end = Math.max(0, Math.min(max, Math.floor(layer)));
    const start = state.preview.singleLayer ? end : Math.min(state.preview.visibleLayerStart, end);
    const maxMove = activeLayerMaxMove === undefined
      ? state.preview.maxMove
      : Math.max(0, Math.floor(activeLayerMaxMove));
    return {
      layer: end,
      preview: {
        ...state.preview,
        visibleLayerStart: start,
        visibleLayerEnd: end,
        maxMove,
        activeMoveStart: 0,
        activeMoveEnd: maxMove,
      },
    };
  }),
  setPreviewMoveRange: ([first, last]) => set((state) => {
    const max = Math.max(0, state.preview.maxMove);
    const a = Math.max(0, Math.min(max, Math.floor(first)));
    const b = Math.max(a, Math.min(max, Math.floor(last)));
    return { preview: { ...state.preview, activeMoveStart: a, activeMoveEnd: b } };
  }),
  setPreviewMoveEnd: (move) => set((state) => {
    const max = Math.max(0, state.preview.maxMove);
    const end = Math.max(0, Math.min(max, Math.floor(move)));
    return { preview: { ...state.preview, activeMoveEnd: Math.max(state.preview.activeMoveStart, end) } };
  }),
  setPreviewShowTravel: (showTravel) => set((state) => ({ preview: { ...state.preview, showTravel } })),
  setPreviewDimPreviousLayers: (dimPreviousLayers) => set((state) => ({ preview: { ...state.preview, dimPreviousLayers } })),
  setPreviewColorScheme: (colorScheme) => set((state) => ({ preview: { ...state.preview, colorScheme } })),
  setPreviewFeatureVisibility: (feature, visible) => set((state) => ({
    preview: { ...state.preview, featureVisibility: { ...state.preview.featureVisibility, [feature]: visible } },
  })),
  setPreviewSingleLayer: (singleLayer) => set((state) => ({
    preview: {
      ...state.preview,
      singleLayer,
      visibleLayerStart: singleLayer ? state.layer : 0,
      visibleLayerEnd: state.layer,
    },
  })),
  resetPreviewState: () => set((state) => ({
    layer: 0,
    preview: { ...DEFAULT_PREVIEW_STATE },
    maxLayer: 0,
    layers: 0,
    error: state.error,
  })),
  invalidateSliceResult: () => set({
    status: 'idle',
    progress: 0,
    layers: 0,
    error: null,
    resultExported: false,
    layer: 0,
    maxLayer: 0,
    preview: { ...DEFAULT_PREVIEW_STATE },
  }),
}));
