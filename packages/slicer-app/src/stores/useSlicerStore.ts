import { create } from 'zustand';

export type SliceStatus = 'idle' | 'slicing' | 'done' | 'error';

interface SlicerState {
  status: SliceStatus;
  progress: number;
  layers: number;
  error: string | null;
  /** A completed slice remains dirty until its G-code is saved by the host. */
  resultExported: boolean;
  layer: number; // scrubber position (0-based, default = max)
  maxLayer: number;
  setStatus: (s: SliceStatus) => void;
  setProgress: (p: number) => void;
  setLayers: (n: number) => void;
  setError: (e: string | null) => void;
  setLayer: (n: number) => void;
  setMaxLayer: (n: number) => void;
  setResultExported: (exported: boolean) => void;
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
  setStatus: (status) => set({ status }),
  setProgress: (progress) => set({ progress }),
  setLayers: (layers) => set({ layers }),
  setError: (error) => set({ error }),
  setLayer: (layer) => set({ layer }),
  setMaxLayer: (maxLayer) => set({ maxLayer }),
  setResultExported: (resultExported) => set({ resultExported }),
  invalidateSliceResult: () => set({
    status: 'idle',
    progress: 0,
    layers: 0,
    error: null,
    resultExported: false,
    layer: 0,
    maxLayer: 0,
  }),
}));
