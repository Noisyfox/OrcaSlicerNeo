// apps/desktop/src/renderer/src/components/viewport/transformMath.ts
// Pure helpers for the move gizmo / move panel — unit-tested without React.
import * as THREE from 'three';
import type { Vec3 } from '../../lib/vec3';

/** Object-local bounding-box min Z (bed contact plane for Drop to bed). */
export function computeObjectMinZ(geometry: THREE.BufferGeometry): number {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  return geometry.boundingBox!.min.z;
}

/** Assemble the store's three transform maps from the loaded objects. */
export function buildTransformSeeds(objects: Array<{
  objectIdx: number;
  offset: Vec3;
  minZ: number;
}>): {
  positions: Record<number, Vec3>;
  initialPositions: Record<number, Vec3>;
  objectMinZ: Record<number, number>;
} {
  const positions: Record<number, Vec3> = {};
  const initialPositions: Record<number, Vec3> = {};
  const objectMinZ: Record<number, number> = {};
  for (const o of objects) {
    positions[o.objectIdx] = o.offset;
    initialPositions[o.objectIdx] = o.offset;
    objectMinZ[o.objectIdx] = o.minZ;
  }
  return { positions, initialPositions, objectMinZ };
}

/** Z offset at which the object's local min Z rests on the bed (Z=0). */
export function computeDropZ(minZ: number): number {
  // `-minZ` alone yields -0 for minZ === 0, which fails Object.is equality
  // with 0 (vitest toBe) and would leak a -0 into the store; normalize.
  return minZ === 0 ? 0 : -minZ;
}

/** Parse a numeric input; null for anything non-finite. */
export function parseNumberInput(text: string): number | null {
  if (text.trim() === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** Position input display format (mm, 3 decimals — slicer convention). */
export function formatPosition(v: number): string {
  return v.toFixed(3);
}
