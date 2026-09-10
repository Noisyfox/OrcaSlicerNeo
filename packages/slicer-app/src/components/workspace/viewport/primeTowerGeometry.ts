import type { PrimeTowerPlateProjection } from '@slicer/client';
import * as THREE from 'three';

/** A plate-local position that keeps the native projected footprint in bounds. */
export interface PrimeTowerPosition {
  x: number;
  y: number;
}

export function clampPrimeTowerPosition(
  projection: PrimeTowerPlateProjection,
  requested: PrimeTowerPosition,
): PrimeTowerPosition {
  const footprint = projection.footprint;
  const position = projection.position;
  const minOffsetX = footprint.minX - position.x;
  const maxOffsetX = footprint.maxX - position.x;
  const minOffsetY = footprint.minY - position.y;
  const maxOffsetY = footprint.maxY - position.y;
  const area = projection.buildArea;
  const clampAxis = (value: number, minOffset: number, maxOffset: number, min: number, max: number) => {
    const lower = min - minOffset;
    const upper = max - maxOffset;
    return lower <= upper ? Math.min(upper, Math.max(lower, value)) : (min + max - minOffset - maxOffset) / 2;
  };
  return {
    x: clampAxis(requested.x, minOffsetX, maxOffsetX, area.minX, area.maxX),
    y: clampAxis(requested.y, minOffsetY, maxOffsetY, area.minY, area.maxY),
  };
}

/** World-space AABB used by the ordinary selection bracket. */
export function primeTowerWorldBounds(
  projection: PrimeTowerPlateProjection,
  position: PrimeTowerPosition = projection.position,
  plateOrigin: readonly [number, number, number] = [0, 0, 0],
): THREE.Box3 {
  const radians = projection.rotation * Math.PI / 180;
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  const bounds = new THREE.Box3().makeEmpty();
  for (const [x, y] of [[0, 0], [projection.width, 0], [projection.width, projection.depth], [0, projection.depth]] as const) {
    bounds.expandByPoint(new THREE.Vector3(
      plateOrigin[0] + position.x + cos * x - sin * y,
      plateOrigin[1] + position.y + sin * x + cos * y,
      plateOrigin[2],
    ));
    bounds.expandByPoint(new THREE.Vector3(
      plateOrigin[0] + position.x + cos * x - sin * y,
      plateOrigin[1] + position.y + sin * x + cos * y,
      plateOrigin[2] + projection.height,
    ));
  }
  return bounds;
}
