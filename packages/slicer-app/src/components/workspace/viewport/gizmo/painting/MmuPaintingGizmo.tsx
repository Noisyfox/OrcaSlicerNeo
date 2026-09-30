import type { LoadedObject } from '@/components/workspace/viewport/useModelLoader';
import type { ReactNode } from 'react';
import { PaintingGizmoBase } from './PaintingGizmoBase';
import type { FilamentSessionSnapshot } from '@slicer/client';
import * as THREE from 'three';
import type { PaintingDisplay } from './PaintingController';

/** MMU annotation adapter: state zero inherits the effective part assignment;
 * positive states address the project palette, with its existing slot-1 fallback.
 * Shared interaction/rendering never reads filament business state directly. */
export function mmuPaintingColor(rack: FilamentSessionSnapshot | null, objectId: number, volumeId: number, state: number): string {
  const assignment = rack?.assignments.parts.find((p) => p.id === volumeId)?.effectiveSlot
    ?? rack?.assignments.objects.find((o) => o.id === objectId)?.effectiveSlot ?? 1;
  return mmuSlotColor(rack, state || assignment);
}
function mmuSlotColor(rack: FilamentSessionSnapshot | null, state: number): string {
  return rack?.slots.find((s) => s.slot === state)?.colour.effective ?? rack?.slots[0]?.colour.effective ?? '#cccccc';
}
/** Orca's seed-fill highlight multiplies encoded RGB by 1.25 and clamps.
 * Convert back into Three's linear working space only after that operation. */
export function mmuPaintingCursorColor(display: PaintingDisplay, state: number): THREE.Color {
  // Treat the source style channels as raw encoded values, avoiding an
  // unnecessary sRGB -> linear -> approximate sRGB round trip before highlight.
  const encoded = new THREE.Color().setStyle(mmuSlotColor(display.palette, state), THREE.LinearSRGBColorSpace);
  return new THREE.Color().setRGB(Math.min(encoded.r * 1.25, 1), Math.min(encoded.g * 1.25, 1), Math.min(encoded.b * 1.25, 1), THREE.SRGBColorSpace);
}
export function MmuPaintingGizmo({ volumes, openingVisual }: { volumes: readonly LoadedObject[]; openingVisual: ReactNode }) {
  return <PaintingGizmoBase volumes={volumes} openingVisual={openingVisual} resolveCursorColor={mmuPaintingCursorColor} resolveColor={(display, volumeId, facetState) => mmuPaintingColor(display.palette, display.session.objectId, volumeId, facetState)} />;
}
