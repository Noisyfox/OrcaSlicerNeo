import type { ReactNode } from 'react';
import * as THREE from 'three';
import type { LoadedObject } from '@/components/workspace/viewport/useModelLoader';
import type { PaintingDisplay } from './PaintingController';
import { PaintingGizmoBase } from './PaintingGizmoBase';

/** Native neutral/enforcer/blocker colours, independent of material slots. */
export function seamPaintingColor(state: number): string {
  return state === 1 ? '#80ff80' : state === 2 ? '#ff8080' : '#cccccc';
}
export function seamPaintingCursorColor(_display: PaintingDisplay, state: number): THREE.Color {
  return new THREE.Color(seamPaintingColor(state));
}
export function SeamPaintingGizmo({ volumes, openingVisual }: { volumes: readonly LoadedObject[]; openingVisual: ReactNode }) {
  return <PaintingGizmoBase volumes={volumes} openingVisual={openingVisual} resolveCursorColor={seamPaintingCursorColor} resolveColor={(_display, _volumeId, state) => seamPaintingColor(state)} />;
}
