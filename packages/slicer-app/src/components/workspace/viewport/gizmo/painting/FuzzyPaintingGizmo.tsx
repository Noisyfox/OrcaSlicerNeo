import * as THREE from 'three';
import type { PaintingDisplay } from './PaintingController';
import { PaintingGizmoBase, type PaintingGizmoProps } from './PaintingGizmoBase';

/** Native neutral/enabled colours, independent of material slots. */
export function fuzzyPaintingColor(state: number): string {
  return state === 1 ? '#80ff80' : '#cccccc';
}
export function fuzzyPaintingCursorColor(_display: PaintingDisplay, state: number): THREE.Color {
  return new THREE.Color(fuzzyPaintingColor(state));
}
export function FuzzyPaintingGizmo(props: PaintingGizmoProps) {
  return <PaintingGizmoBase {...props} resolveCursorColor={fuzzyPaintingCursorColor} resolveColor={(_display, _volumeId, state) => fuzzyPaintingColor(state)} />;
}
