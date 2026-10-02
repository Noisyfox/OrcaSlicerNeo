import type { ReactNode } from 'react';
import * as THREE from 'three';
import type { LoadedObject } from '@/components/workspace/viewport/useModelLoader';
import type { PaintingDisplay } from './PaintingController';
import { PaintingGizmoBase } from './PaintingGizmoBase';

/** Native neutral/enabled colours, independent of material slots. */
export function fuzzyPaintingColor(state: number): string {
  return state === 1 ? '#80ff80' : '#cccccc';
}
export function fuzzyPaintingCursorColor(_display: PaintingDisplay, state: number): THREE.Color {
  return new THREE.Color(fuzzyPaintingColor(state));
}
export function FuzzyPaintingGizmo({ volumes, openingVisual }: { volumes: readonly LoadedObject[]; openingVisual: ReactNode }) {
  return <PaintingGizmoBase volumes={volumes} openingVisual={openingVisual} resolveCursorColor={fuzzyPaintingCursorColor} resolveColor={(_display, _volumeId, state) => fuzzyPaintingColor(state)} />;
}
