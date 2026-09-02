import type { ToolpathGeometry } from './useSliceResult';
import { TRAVEL_MOVE_TYPE } from './toolpathColors';

/** EMoveType::Travel in libslic3r/libvgcode (kept at the contract boundary). */
export { TRAVEL_MOVE_TYPE };

export function previewViewportOwnsKeyboardFocus(target: Element | null, viewport: Element | null, activeElement: Element | null): boolean {
  if (!viewport || !target || activeElement !== viewport || !viewport.contains(target)) return false;
  if (target.closest('input, textarea, select, [contenteditable="true"], button, [role="slider"]')) return false;
  return true;
}

/** Keyboard acceleration shared by the DOM handler and focused unit tests. */
export function previewKeyboardStep(modifiers: Pick<KeyboardEvent, 'shiftKey' | 'ctrlKey' | 'metaKey'>): number {
  return modifiers.shiftKey || modifiers.ctrlKey || modifiers.metaKey ? 5 : 1;
}

export function isPreviewInspectionKey(key: string): boolean {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight' || key.toLowerCase() === 'l';
}

export interface PreviewVisibilityOptions {
  visibleLayerStart: number;
  visibleLayerEnd: number;
  activeMoveEnd: number;
  showTravel: boolean;
  dimPreviousLayers: boolean;
  visibility?: Readonly<Record<number, boolean>>;
  visibilityField?: 'feature' | 'filament';
}

export interface PreviewVisibility {
  visible: Uint8Array;
  dimmed: Uint8Array;
}

export function clampPreviewRange(first: number, last: number, max: number): [number, number] {
  const upper = Math.max(0, Math.floor(Number.isFinite(max) ? max : 0));
  const a = Math.max(0, Math.min(upper, Math.floor(Number.isFinite(first) ? first : 0)));
  const b = Math.max(a, Math.min(upper, Math.floor(Number.isFinite(last) ? last : a)));
  return [a, b];
}

export function maxMoveOrderForLayer(data: Pick<ToolpathGeometry, 'segmentCount' | 'layerIds' | 'moveOrders'>, layer: number): number {
  let max = 0;
  for (let i = 0; i < data.segmentCount; i++) {
    if (data.layerIds[i] === layer) max = Math.max(max, data.moveOrders[i] ?? 0);
  }
  return max;
}

export function lastMovePosition(data: Pick<ToolpathGeometry, 'segmentCount' | 'ends' | 'layerIds' | 'moveOrders'>, layer: number, move: number): [number, number, number] | null {
  let fallback = -1;
  let exact = -1;
  for (let i = 0; i < data.segmentCount; i++) {
    if (data.layerIds[i] !== layer) continue;
    fallback = i;
    if ((data.moveOrders[i] ?? 0) <= move) exact = i;
  }
  const index = exact >= 0 ? exact : fallback;
  if (index < 0) return null;
  return [data.ends[index * 3] ?? 0, data.ends[index * 3 + 1] ?? 0, data.ends[index * 3 + 2] ?? 0];
}

/**
 * A result-local lookup for inspection.  Building this once per result keeps
 * slider updates logarithmic and avoids repeatedly scanning million-segment
 * toolpaths on the React render path.
 */
export interface PreviewInspectionIndex {
  readonly movesByLayer: ReadonlyMap<number, readonly number[]>;
}

export function createPreviewInspectionIndex(
  data: Pick<ToolpathGeometry, 'segmentCount' | 'layerIds' | 'moveOrders'>,
): PreviewInspectionIndex {
  const byLayer = new Map<number, number[]>();
  for (let index = 0; index < data.segmentCount; index++) {
    const layer = data.layerIds[index] ?? 0;
    const moves = byLayer.get(layer);
    if (moves) moves.push(index);
    else byLayer.set(layer, [index]);
  }
  for (const moves of byLayer.values()) {
    moves.sort((a, b) => (data.moveOrders[a] ?? 0) - (data.moveOrders[b] ?? 0) || a - b);
  }
  return { movesByLayer: byLayer };
}

/** Return the nearest move at or before the requested local move order. */
export function findPreviewMove(
  data: Pick<ToolpathGeometry, 'moveOrders'>,
  index: PreviewInspectionIndex,
  layer: number,
  move: number,
): number | null {
  const moves = index.movesByLayer.get(layer);
  if (!moves?.length) return null;
  let low = 0;
  let high = moves.length - 1;
  let best = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const order = data.moveOrders[moves[middle]!] ?? 0;
    if (order <= move) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return moves[best] ?? null;
}

/**
 * Implements Orca's hide semantics in a compact CPU-side visibility buffer.
 * The buffer is uploaded to a prebuilt instanced geometry attribute; changing
 * these choices never rebuilds geometry or the scene graph.
 */
export function buildPreviewVisibility(
  data: Pick<ToolpathGeometry, 'segmentCount' | 'layerIds' | 'moveOrders' | 'moveTypes' | 'features' | 'extruderIds'>,
  options: PreviewVisibilityOptions,
): PreviewVisibility {
  const visible = new Uint8Array(data.segmentCount);
  const dimmed = new Uint8Array(data.segmentCount);
  const [layerStart, layerEnd] = clampPreviewRange(options.visibleLayerStart, options.visibleLayerEnd, Number.MAX_SAFE_INTEGER);
  const moveEnd = Math.max(0, Math.floor(options.activeMoveEnd));
  for (let i = 0; i < data.segmentCount; i++) {
    const layer = data.layerIds[i] ?? 0;
    if (layer < layerStart || layer > layerEnd) continue;
    if (layer === layerEnd && (data.moveOrders[i] ?? 0) > moveEnd) continue;
    if (!options.showTravel && (data.moveTypes[i] ?? 0) === TRAVEL_MOVE_TYPE) continue;
    // libvgcode keeps travel under the independent Travels option; a stale
    // extrusion role on a travel vertex must not make a feature filter hide it.
    if ((data.moveTypes[i] ?? 0) !== TRAVEL_MOVE_TYPE) {
      const id = options.visibilityField === 'filament' ? data.extruderIds[i] ?? 0 : data.features[i] ?? 0;
      if (options.visibility && options.visibility[id] === false) continue;
    }
    visible[i] = 1;
    dimmed[i] = options.dimPreviousLayers && layer < layerEnd ? 1 : 0;
  }
  return { visible, dimmed };
}
