import { create } from 'zustand';

export type SliceStatus = 'idle' | 'slicing' | 'done' | 'error';

interface SlicerState {
  status: SliceStatus;
  progress: number;
  layers: number;
  error: string | null;
  setStatus: (s: SliceStatus) => void;
  setProgress: (p: number) => void;
  setLayers: (n: number) => void;
  setError: (e: string | null) => void;
}

export const useSlicerStore = create<SlicerState>((set) => ({
  status: 'idle',
  progress: 0,
  layers: 0,
  error: null,
  setStatus: (status) => set({ status }),
  setProgress: (progress) => set({ progress }),
  setLayers: (layers) => set({ layers }),
  setError: (error) => set({ error }),
}));
