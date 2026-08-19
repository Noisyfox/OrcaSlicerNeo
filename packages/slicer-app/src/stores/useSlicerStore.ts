import { create } from 'zustand';

export type SliceStatus = 'idle' | 'slicing' | 'done' | 'error';

interface SlicerState {
  status: SliceStatus;
  progress: number;
  layers: number;
  error: string | null;
  layer: number; // scrubber position (0-based, default = max)
  maxLayer: number;
  setStatus: (s: SliceStatus) => void;
  setProgress: (p: number) => void;
  setLayers: (n: number) => void;
  setError: (e: string | null) => void;
  setLayer: (n: number) => void;
  setMaxLayer: (n: number) => void;
}

export const useSlicerStore = create<SlicerState>((set) => ({
  status: 'idle',
  progress: 0,
  layers: 0,
  error: null,
  layer: 0,
  maxLayer: 0,
  setStatus: (status) => set({ status }),
  setProgress: (progress) => set({ progress }),
  setLayers: (layers) => set({ layers }),
  setError: (error) => set({ error }),
  setLayer: (layer) => set({ layer }),
  setMaxLayer: (maxLayer) => set({ maxLayer }),
}));
