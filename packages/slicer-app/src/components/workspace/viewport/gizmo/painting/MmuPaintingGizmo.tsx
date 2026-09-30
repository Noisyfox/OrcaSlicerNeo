import type { LoadedObject } from '../../useModelLoader';
import type { ReactNode } from 'react';
import { PaintingGizmoBase } from './PaintingGizmoBase';
import type { FilamentSessionSnapshot } from '@slicer/client';

/** MMU annotation adapter: state zero inherits the effective part assignment;
 * positive states address the project palette, with its existing slot-1 fallback.
 * Shared interaction/rendering never reads filament business state directly. */
export function mmuPaintingColor(rack: FilamentSessionSnapshot | null, objectId: number, volumeId: number, state: number): string {
  const assignment = rack?.assignments.parts.find((p) => p.id === volumeId)?.effectiveSlot
    ?? rack?.assignments.objects.find((o) => o.id === objectId)?.effectiveSlot ?? 1;
  return rack?.slots.find((s) => s.slot === (state || assignment))?.colour.effective ?? rack?.slots[0]?.colour.effective ?? '#cccccc';
}
export function MmuPaintingGizmo({ volumes, openingVisual }: { volumes: readonly LoadedObject[]; openingVisual: ReactNode }) {
  return <PaintingGizmoBase volumes={volumes} openingVisual={openingVisual} resolveColor={(display, volumeId, facetState) => mmuPaintingColor(display.palette, display.session.objectId, volumeId, facetState)} />;
}
