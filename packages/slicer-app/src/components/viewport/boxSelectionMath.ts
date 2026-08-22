// Pure screen-space rectangle math for the Shift+drag box selection marquee.
// Kept outside the controller so the geometry is trivially unit-testable.

/** A rectangle in viewport CSS pixels. */
export interface BoxRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Pointer coordinates in viewport CSS pixels. */
export interface BoxPoint {
  readonly x: number;
  readonly y: number;
}

/** Minimum drag distance before a Shift press arms the marquee. */
export const BOX_SELECT_ARM_THRESHOLD_PX = 4;

/** Normalize a corner-to-corner marquee into a non-negative rect. */
export function normalizeRect(start: BoxPoint, current: BoxPoint): BoxRect {
  return {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  };
}

/** Inclusive overlap — edge-touching rects intersect, matching native box select. */
export function rectsOverlap(a: BoxRect, b: BoxRect): boolean {
  return a.x <= b.x + b.width
    && a.x + a.width >= b.x
    && a.y <= b.y + b.height
    && a.y + a.height >= b.y;
}

/** Smallest axis-aligned rect containing both inputs. */
export function unionRects(a: BoxRect, b: BoxRect): BoxRect {
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.width, b.x + b.width);
  const maxY = Math.max(a.y + a.height, b.y + b.height);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
