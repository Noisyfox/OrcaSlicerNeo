import { create } from 'zustand';
import type { PlateOperationTarget } from '@slicer/client';

export type SliceStatus = 'idle' | 'slicing' | 'done' | 'error';
export type PreviewColorScheme = 'feature' | 'filament' | 'speed' | 'volumetricFlow' | 'layerTime' | 'temperature' | 'fanSpeed';
export type PreviewSchemeVisibility = Partial<Record<PreviewColorScheme, Record<number, boolean>>>;

export interface PreviewState {
  visibleLayerStart: number;
  visibleLayerEnd: number;
  activeMoveEnd: number;
  maxMove: number;
  showTravel: boolean;
  dimPreviousLayers: boolean;
  colorScheme: PreviewColorScheme;
  schemeVisibility: PreviewSchemeVisibility;
  singleLayer: boolean;
  resultId: number | null;
}

export const DEFAULT_PREVIEW_STATE: PreviewState = {
  visibleLayerStart: 0,
  visibleLayerEnd: 0,
  activeMoveEnd: 0,
  maxMove: 0,
  showTravel: true,
  dimPreviousLayers: true,
  colorScheme: 'feature',
  schemeVisibility: {},
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
  /** Identity of the single current-plate result until Step 8's cache. */
  sliceTarget: PlateOperationTarget | null;
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
  setSliceTarget: (target: PlateOperationTarget | null) => void;
  setPreviewBounds: (maxLayer: number, maxMove: number, resultId?: number | null) => void;
  /** Update the inclusive visible range and the active layer's local move bound atomically. */
  setPreviewLayerRange: (range: [number, number], activeLayerMaxMove?: number) => void;
  /** Move the active inspection layer, resetting its local move end atomically. */
  setPreviewLayerEnd: (layer: number, activeLayerMaxMove?: number) => void;
  setPreviewMoveEnd: (move: number) => void;
  setPreviewShowTravel: (show: boolean) => void;
  setPreviewDimPreviousLayers: (dim: boolean) => void;
  setPreviewColorScheme: (scheme: PreviewColorScheme) => void;
  setPreviewSchemeVisibility: (scheme: PreviewColorScheme, item: number, visible: boolean) => void;
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
  sliceTarget: null,
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
  setSliceTarget: (sliceTarget) => set({ sliceTarget }),
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
    // In single-layer mode both vertical thumbs represent the same active
    // layer.  The two Slider roots still report a pair of values, so choose
    // the endpoint that changed before applying the usual non-reversing
    // range clamp.  Otherwise lowering the end thumb from [layer, layer]
    // would be clamped back to the old start and the control would appear
    // stuck.
    if (state.preview.singleLayer) {
      const requestedFirst = Math.floor(first);
      const requestedLast = Math.floor(last);
      const requestedLayer = requestedLast !== state.preview.visibleLayerEnd
        ? requestedLast
        : requestedFirst !== state.preview.visibleLayerStart
          ? requestedFirst
          : requestedLast;
      const activeLayer = Math.max(0, Math.min(max, requestedLayer));
      const maxMove = activeLayerMaxMove === undefined
        ? state.preview.maxMove
        : Math.max(0, Math.floor(activeLayerMaxMove));
      return {
        layer: activeLayer,
        preview: {
          ...state.preview,
          visibleLayerStart: activeLayer,
          visibleLayerEnd: activeLayer,
          maxMove,
          activeMoveEnd: maxMove,
        },
      };
    }
    const a = Math.max(0, Math.min(max, Math.floor(first)));
    const b = Math.max(a, Math.min(max, Math.floor(last)));
    const layerChanged = b !== state.preview.visibleLayerEnd;
    const maxMove = activeLayerMaxMove === undefined
      ? state.preview.maxMove
      : Math.max(0, Math.floor(activeLayerMaxMove));
    const activeMoveEnd = layerChanged ? maxMove : Math.max(0, Math.min(maxMove, state.preview.activeMoveEnd));
    return {
      layer: b,
      preview: { ...state.preview, visibleLayerStart: a, visibleLayerEnd: b, maxMove, activeMoveEnd },
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
        activeMoveEnd: maxMove,
      },
    };
  }),
  setPreviewMoveEnd: (move) => set((state) => {
    const max = Math.max(0, state.preview.maxMove);
    const end = Math.max(0, Math.min(max, Math.floor(move)));
    return { preview: { ...state.preview, activeMoveEnd: end } };
  }),
  setPreviewShowTravel: (showTravel) => set((state) => ({ preview: { ...state.preview, showTravel } })),
  setPreviewDimPreviousLayers: (dimPreviousLayers) => set((state) => ({ preview: { ...state.preview, dimPreviousLayers } })),
  setPreviewColorScheme: (colorScheme) => set((state) => ({ preview: { ...state.preview, colorScheme } })),
  setPreviewSchemeVisibility: (scheme, item, visible) => set((state) => ({
    preview: {
      ...state.preview,
      schemeVisibility: {
        ...state.preview.schemeVisibility,
        [scheme]: { ...state.preview.schemeVisibility[scheme], [item]: visible },
      },
    },
  })),
  setPreviewSingleLayer: (singleLayer) => set((state) => {
    const max = Math.max(0, state.maxLayer);
    const activeLayer = Math.max(0, Math.min(max, Math.floor(state.preview.visibleLayerEnd)));
    return {
      layer: activeLayer,
      preview: {
        ...state.preview,
        singleLayer,
        visibleLayerStart: singleLayer ? activeLayer : 0,
        visibleLayerEnd: activeLayer,
      },
    };
  }),
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
    sliceTarget: null,
    layer: 0,
    maxLayer: 0,
    preview: { ...DEFAULT_PREVIEW_STATE },
  }),
}));
