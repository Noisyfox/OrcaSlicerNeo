import { create } from 'zustand';
import type { LayerHeightFrame } from '@slicer/client';

export const useLayerHeight = create(() => ({
  frame: null as LayerHeightFrame | null,
  quality: 0.5, radius: 5, keepMin: false, width: 2,
  cursor: null as number | null,
  busy: false,
}));

type LayerHeightScene = { readonly gizmo: string | null; closeGizmo(): boolean };
let scene: LayerHeightScene | null = null;

export function registerLayerHeightScene(current: LayerHeightScene) {
  scene = current;
  return () => { if (scene === current) scene = null; };
}
export function closeLayerHeightForSlice() {
  if (useLayerHeight.getState().busy) return false;
  if (scene?.gizmo === 'layer-height') return scene.closeGizmo();
  return true;
}
