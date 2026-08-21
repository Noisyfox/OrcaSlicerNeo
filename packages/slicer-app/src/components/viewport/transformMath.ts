// packages/slicer-app/src/components/viewport/transformMath.ts
// Pure display/input helpers for the scene-selection move panel.
import type { Vec3 } from '../../lib/vec3';

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

/** Rotation display format (degrees, 1 decimal — slicer convention). */
export function formatDegrees(v: number): string {
  return v.toFixed(1);
}

/** Scale-factor display format (percent of the original size). */
export function formatPercent(v: number): string {
  return (v * 100).toFixed(1);
}

/** Degrees → radians (the stored rotation unit). */
export function degreesToRadians(degrees: Vec3): Vec3 {
  return [degrees[0], degrees[1], degrees[2]].map((d) => (d * Math.PI) / 180) as Vec3;
}

/** Radians → degrees (display unit). */
export function radiansToDegrees(radians: Vec3): Vec3 {
  return [radians[0], radians[1], radians[2]].map((r) => (r * 180) / Math.PI) as Vec3;
}
