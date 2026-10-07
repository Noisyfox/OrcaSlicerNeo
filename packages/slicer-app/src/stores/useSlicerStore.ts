import { create } from 'zustand';
import type { PlateOperationTarget, SliceResultReceipt, PreviewAnalysisSummary } from '@slicer/client';

export type SliceStatus = 'idle' | 'slicing' | 'done' | 'error';
export type PreviewColorScheme = 'feature' | 'filament' | 'speed' | 'volumetricFlow' | 'layerTime' | 'temperature' | 'fanSpeed';
export type PreviewSchemeVisibility = Partial<Record<PreviewColorScheme, Record<number, boolean>>>;

export interface PreviewState {
  visibleLayerStart: number;
  visibleLayerEnd: number;
  activeMoveEnd: number;
  maxMove: number;
  showTravel: boolean;
  moveVisibility: Record<number, boolean>;
  dimPreviousLayers: boolean;
  colorScheme: PreviewColorScheme;
  schemeVisibility: PreviewSchemeVisibility;
  singleLayer: boolean;
  resultId: number | null;
}

export interface PlateSliceResult {
  target: PlateOperationTarget;
  /** Lightweight address of the Worker-retained result; never renderer data. */
  receipt: SliceResultReceipt;
  /** Native advisory warnings scoped to this plate result. */
  warnings: readonly string[];
  summary: PreviewAnalysisSummary;
}

export interface PlateSliceFailure { target: PlateOperationTarget; error: string; }

export const DEFAULT_PREVIEW_STATE: PreviewState = {
  visibleLayerStart: 0,
  visibleLayerEnd: 0,
  activeMoveEnd: 0,
  maxMove: 0,
  showTravel: true,
  moveVisibility: {},
  dimPreviousLayers: true,
  colorScheme: 'feature',
  schemeVisibility: {},
  singleLayer: false,
  resultId: null,
};

/** Result bounds are transient; display choices belong to the UI session. */
function resetPreviewProjection(preview: PreviewState): PreviewState {
  return {
    ...DEFAULT_PREVIEW_STATE,
    colorScheme: preview.colorScheme,
    schemeVisibility: preview.schemeVisibility,
    moveVisibility: preview.moveVisibility,
    showTravel: preview.showTravel,
    dimPreviousLayers: preview.dimPreviousLayers,
    singleLayer: preview.singleLayer,
  };
}

interface SlicerState {
  status: SliceStatus;
  progress: number;
  progressText: string;
  plateFailures: Readonly<Record<string, PlateSliceFailure>>;
  layers: number;
  error: string | null;
  /** A completed slice remains dirty until its G-code is saved by the host. */
  resultExported: boolean;
  /** Identity of the single current-plate result until Step 8's cache. */
  sliceTarget: PlateOperationTarget | null;
  /** Session-lifetime completed results, keyed by immutable plate identity. */
  plateResults: Readonly<Record<string, PlateSliceResult>>;
  /** The one job allowed to run at a time. */
  activeSliceTarget: PlateOperationTarget | null;
  layer: number; // scrubber position (0-based, default = max)
  maxLayer: number;
  preview: PreviewState;
  showGcodeText: boolean;
  setShowGcodeText: (visible: boolean) => void;
  setStatus: (s: SliceStatus) => void;
  setProgress: (p: number) => void;
  setProgressText: (text: string) => void;
  setPlateFailure: (target: PlateOperationTarget, error: string) => void;
  setLayers: (n: number) => void;
  setError: (e: string | null) => void;
  setLayer: (n: number) => void;
  setMaxLayer: (n: number) => void;
  setResultExported: (exported: boolean) => void;
  setSliceTarget: (target: PlateOperationTarget | null) => void;
  setActiveSliceTarget: (target: PlateOperationTarget | null) => void;
  setPlateResult: (receipt: SliceResultReceipt, warnings: readonly string[], summary: PreviewAnalysisSummary) => void;
  activatePlateResult: (plateId: string, inputRevision: number) => boolean;
  invalidatePlateResults: (plateIds: readonly string[]) => void;
  discardPlateResult: (plateId: string) => void;
  clearPlateResults: () => void;
  setPreviewBounds: (maxLayer: number, maxMove: number, resultId?: number | null) => void;
  /** Update the inclusive visible range and the active layer's local move bound atomically. */
  setPreviewLayerRange: (range: [number, number], activeLayerMaxMove?: number) => void;
  /** Move the active inspection layer, resetting its local move end atomically. */
  setPreviewLayerEnd: (layer: number, activeLayerMaxMove?: number) => void;
  setPreviewMoveEnd: (move: number) => void;
  setPreviewShowTravel: (show: boolean) => void;
  setPreviewMoveVisibility: (type: number, visible: boolean) => void;
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
  plateResults: {},
  activeSliceTarget: null,
  progressText: '',
  plateFailures: {},
  layer: 0,
  maxLayer: 0,
  preview: DEFAULT_PREVIEW_STATE,
  showGcodeText: false,
  setShowGcodeText: (showGcodeText) => set({ showGcodeText }),
  setStatus: (status) => set({ status }),
  setProgress: (progress) => set({ progress }),
  setProgressText: (progressText) => set({ progressText }),
  setPlateFailure: (target, error) => set(state => ({ plateFailures: { ...state.plateFailures, [target.plateId]: { target, error } } })),
  setLayers: (layers) => set({ layers }),
  setError: (error) => set({ error }),
  setLayer: (layer) => set((state) => ({
    layer,
    preview: { ...state.preview, visibleLayerEnd: layer },
  })),
  setMaxLayer: (maxLayer) => set({ maxLayer }),
  setResultExported: (resultExported) => set({ resultExported }),
  setSliceTarget: (sliceTarget) => set({ sliceTarget }),
  setActiveSliceTarget: (activeSliceTarget) => set({ activeSliceTarget }),
  setPlateResult: (receipt, warnings, summary) => set((state) => {
    const target = { plateId: receipt.plateId, inputRevision: receipt.inputStamp };
    const { [target.plateId]: _failure, ...plateFailures } = state.plateFailures;
    return {
      plateFailures,
      plateResults: { ...state.plateResults, [target.plateId]: { target, receipt, warnings: [...warnings], summary: { ...summary } } },
      // Publish the selected plate result to the toolbar and active preview.
      ...(state.sliceTarget?.plateId === target.plateId || state.activeSliceTarget?.plateId === target.plateId
        ? {
          sliceTarget: target,
          status: 'done' as const,
          resultExported: false,
          error: warnings.length ? `[Warning] ${warnings.join('; ')}` : null,
        }
        : {}),
    };
  }),
  activatePlateResult: (plateId, inputRevision) => {
    let matched = false;
    set((state) => {
      const cached = state.plateResults[plateId];
      if (!cached || cached.target.inputRevision !== inputRevision) {
        return {
          sliceTarget: null,
          status: 'idle' as const,
          progress: 0,
          layers: 0,
          error: null,
          resultExported: false,
          layer: 0,
          maxLayer: 0,
          preview: resetPreviewProjection(state.preview),
        };
      }
      matched = true;
      return {
        sliceTarget: cached.target,
        status: 'done' as const,
        progress: 100,
        // The current plate projection materializes asynchronously. Releasing
        // these bounds here prevents a switched plate from inheriting the prior
        // projection's scrubber while its payload is in flight.
        layers: 0,
        layer: 0,
        maxLayer: 0,
        preview: resetPreviewProjection(state.preview),
        error: cached.warnings.length ? `[Warning] ${cached.warnings.join('; ')}` : null,
        resultExported: false,
      };
    });
    return matched;
  },
  invalidatePlateResults: (plateIds) => set((state) => {
    if (plateIds.length === 0) return state;
    const invalidated = new Set(plateIds);
    const plateResults = Object.fromEntries(Object.entries(state.plateResults).filter(([id]) => !invalidated.has(id)));
    const plateFailures = Object.fromEntries(Object.entries(state.plateFailures).filter(([id]) => !invalidated.has(id)));
    const activeAffected = state.activeSliceTarget && invalidated.has(state.activeSliceTarget.plateId);
    const currentAffected = state.sliceTarget && invalidated.has(state.sliceTarget.plateId);
    const slicingAffected = activeAffected || (state.status === 'slicing' && currentAffected);
    return {
      plateResults,
      plateFailures,
      ...(activeAffected ? { activeSliceTarget: null } : {}),
      ...(currentAffected ? {
        sliceTarget: null,
        status: 'idle' as const,
        progress: 0,
        layers: 0,
        error: null,
        resultExported: false,
        layer: 0,
        maxLayer: 0,
        preview: resetPreviewProjection(state.preview),
      } : {}),
      ...(slicingAffected && !currentAffected ? {
        status: state.sliceTarget ? 'done' as const : 'idle' as const,
        progress: state.sliceTarget ? 100 : 0,
      } : {}),
    };
  }),
  discardPlateResult: (plateId) => set((state) => {
    const { [plateId]: _discarded, ...plateResults } = state.plateResults;
    const { [plateId]: _failure, ...plateFailures } = state.plateFailures;
    const current = state.sliceTarget?.plateId === plateId;
    return {
      plateResults,
      plateFailures,
      ...(state.activeSliceTarget?.plateId === plateId ? { activeSliceTarget: null } : {}),
      ...(current ? {
        sliceTarget: null,
        status: 'idle' as const,
        progress: 0,
        layers: 0,
        error: null,
        resultExported: false,
        layer: 0,
        maxLayer: 0,
        preview: resetPreviewProjection(state.preview),
      } : {}),
    };
  }),
  clearPlateResults: () => set({ plateResults: {}, plateFailures: {}, progressText: '', sliceTarget: null, activeSliceTarget: null }),
  setPreviewBounds: (maxLayer, maxMove, resultId = null) => set((state) => ({
    maxLayer,
    layer: maxLayer,
    preview: {
      ...resetPreviewProjection(state.preview),
      visibleLayerStart: state.preview.singleLayer ? Math.max(0, maxLayer) : 0,
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
  setPreviewMoveVisibility: (type, visible) => set((state) => ({ preview: { ...state.preview, moveVisibility: { ...state.preview.moveVisibility, [type]: visible } } })),
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
    preview: resetPreviewProjection(state.preview),
    maxLayer: 0,
    layers: 0,
    error: state.error,
  })),
  invalidateSliceResult: () => set((state) => ({
    status: 'idle',
    progress: 0,
    layers: 0,
    error: null,
    resultExported: false,
    sliceTarget: null,
    plateResults: {},
    plateFailures: {},
    progressText: '',
    activeSliceTarget: null,
    layer: 0,
    maxLayer: 0,
    preview: resetPreviewProjection(state.preview),
  })),
}));
