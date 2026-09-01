import type { ToolpathGeometry } from './useSliceResult';

/** EMoveType::Travel in libslic3r/libvgcode (kept at the contract boundary). */
export const TRAVEL_MOVE_TYPE = 8;

export function previewViewportOwnsKeyboardFocus(target: Element | null, viewport: Element | null, activeElement: Element | null): boolean {
  if (!viewport || !target) return false;
  if (target.closest('input, textarea, select, [contenteditable="true"], button, [role="slider"]')) return false;
  return activeElement === viewport || Boolean(target.closest('canvas'));
}

export interface PreviewVisibilityOptions {
  visibleLayerStart: number;
  visibleLayerEnd: number;
  activeMoveStart: number;
  activeMoveEnd: number;
  showTravel: boolean;
  dimPreviousLayers: boolean;
  featureVisibility?: Readonly<Record<number, boolean>>;
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
 * Implements Orca's hide semantics in a compact CPU-side visibility buffer.
 * The buffer is uploaded to a prebuilt instanced geometry attribute; changing
 * these choices never rebuilds geometry or the scene graph.
 */
export function buildPreviewVisibility(
  data: Pick<ToolpathGeometry, 'segmentCount' | 'layerIds' | 'moveOrders' | 'moveTypes' | 'features'>,
  options: PreviewVisibilityOptions,
): PreviewVisibility {
  const visible = new Uint8Array(data.segmentCount);
  const dimmed = new Uint8Array(data.segmentCount);
  const [layerStart, layerEnd] = clampPreviewRange(options.visibleLayerStart, options.visibleLayerEnd, Number.MAX_SAFE_INTEGER);
  const moveStart = Math.max(0, Math.floor(options.activeMoveStart));
  const moveEnd = Math.max(moveStart, Math.floor(options.activeMoveEnd));
  for (let i = 0; i < data.segmentCount; i++) {
    const layer = data.layerIds[i] ?? 0;
    if (layer < layerStart || layer > layerEnd) continue;
    if (layer === layerEnd && ((data.moveOrders[i] ?? 0) < moveStart || (data.moveOrders[i] ?? 0) > moveEnd)) continue;
    if (!options.showTravel && (data.moveTypes[i] ?? 0) === TRAVEL_MOVE_TYPE) continue;
    const feature = data.features[i] ?? 0;
    if (options.featureVisibility && options.featureVisibility[feature] === false) continue;
    visible[i] = 1;
    dimmed[i] = options.dimPreviousLayers && layer < layerEnd ? 1 : 0;
  }
  return { visible, dimmed };
}
