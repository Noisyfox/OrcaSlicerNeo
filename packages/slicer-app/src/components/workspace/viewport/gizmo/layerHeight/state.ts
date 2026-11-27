import { create } from 'zustand';
import type { LayerHeightFrame } from '@slicer/client';

export const useLayerHeight = create(() => ({
  frame: null as LayerHeightFrame | null,
  quality: 0.5, radius: 5, keepMin: false, width: 2,
  cursor: null as number | null,
  busy: false,
}));
