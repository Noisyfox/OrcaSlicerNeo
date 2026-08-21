// packages/slicer-app/src/components/viewport/transformMath.ts
// Pure display/input helpers for the scene-selection move panel.

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
