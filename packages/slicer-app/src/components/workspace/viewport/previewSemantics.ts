import type { PreviewLayerRange } from '@slicer/client';
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
  const normalized = key.toLowerCase();
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight' || normalized === 'l' || normalized === 'c';
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
 * A result-local lookup for inspection. Layer ranges are supplied by the
 * bridge as contiguous segment intervals, so this only retains one small
 * range record per layer; it never creates or sorts a per-segment index.
 */
export interface PreviewInspectionIndex {
  readonly rangesByLayer: ReadonlyMap<number, Pick<PreviewLayerRange, 'firstSegment' | 'segmentCount'>>;
}

export interface PreviewSourceLineIndex {
  /** Source line numbers are 1-based, matching GCodeProcessor's gcode_id. */
  readonly moveByLine: ReadonlyMap<number, number>;
  readonly mappedLines: readonly number[];
  /** Ordered ids are owned by the result; lookups use binary search without a duplicate map. */
  readonly orderedGcodeIds?: Uint32Array;
}

/** Build the result-local source map once; line clicks never rescan segments. */
export function createPreviewSourceLineIndex(
  data: Pick<ToolpathGeometry, 'segmentCount' | 'gcodeIds' | 'metadata' | 'sourceLineOrderValid'>,
): PreviewSourceLineIndex {
  const moveByLine = new Map<number, number>();
  if (!data.metadata?.sourceLineMapping?.available || !data.gcodeIds) {
    return { moveByLine, mappedLines: [] };
  }
  if (data.sourceLineOrderValid === true) {
    return { moveByLine, mappedLines: [], orderedGcodeIds: data.gcodeIds };
  }
  for (let move = 0; move < data.segmentCount; move++) {
    const line = data.gcodeIds[move];
    if (!Number.isSafeInteger(line) || line < 1) continue;
    // The processor emits one gcode_id per mapped move. Keep the first move
    // if a malformed source repeats an id, preserving deterministic behavior.
    if (!moveByLine.has(line)) moveByLine.set(line, move);
  }
  return { moveByLine, mappedLines: [...moveByLine.keys()].sort((a, b) => a - b) };
}

/** Return the exact mapped move, or the nearest preceding mapped move. */
export function findPreviewMoveForSourceLine(index: PreviewSourceLineIndex, lineNumber: number): number | null {
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return null;
  if (index.orderedGcodeIds) {
    let low = 0;
    let high = index.orderedGcodeIds.length - 1;
    let firstAtOrAfter = index.orderedGcodeIds.length;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (index.orderedGcodeIds[middle] >= lineNumber) {
        firstAtOrAfter = middle;
        high = middle - 1;
      } else low = middle + 1;
    }
    if (firstAtOrAfter >= index.orderedGcodeIds.length || index.orderedGcodeIds[firstAtOrAfter] > lineNumber) {
      const predecessor = firstAtOrAfter - 1;
      return predecessor < 0 || index.orderedGcodeIds[predecessor] < 1 ? null : predecessor;
    }
    return firstAtOrAfter;
  }
  if (index.mappedLines.length === 0) return null;
  const exact = index.moveByLine.get(lineNumber);
  if (exact !== undefined) return exact;
  let low = 0;
  let high = index.mappedLines.length - 1;
  let best = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (index.mappedLines[middle] <= lineNumber) {
      best = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best < 0 ? null : index.moveByLine.get(index.mappedLines[best]) ?? null;
}

export function sourceLineForPreviewMove(
  data: Pick<ToolpathGeometry, 'gcodeIds'>,
  index: PreviewSourceLineIndex,
  move: number,
): number | null {
  const line = data.gcodeIds?.[move];
  if (line === undefined || line < 1) return null;
  // Reverse navigation is intentionally many-to-one: duplicate source IDs
  // still highlight the selected move's own source line. Forward clicks use
  // the index's first duplicate, but active-move highlighting must not drop
  // later moves from the same source line.
  if (index.orderedGcodeIds) return line;
  return index.moveByLine.has(line) ? line : null;
}

export function createPreviewInspectionIndex(
  data: Pick<ToolpathGeometry, 'segmentCount' | 'layerIds' | 'moveOrders' | 'metadata'>,
): PreviewInspectionIndex {
  const rangesByLayer = new Map<number, Pick<PreviewLayerRange, 'firstSegment' | 'segmentCount'>>();
  for (const range of data.metadata?.layerRanges ?? []) {
    const firstSegment = Math.floor(range.firstSegment);
    const segmentCount = Math.floor(range.segmentCount);
    const lastSegment = firstSegment + segmentCount - 1;
    // A malformed metadata interval must never make the inspector read an
    // unrelated layer. The normal bridge path always satisfies this contract.
    if (firstSegment < 0 || segmentCount <= 0 || lastSegment >= data.segmentCount) continue;
    if (data.layerIds[firstSegment] !== range.id || data.layerIds[lastSegment] !== range.id) continue;
    rangesByLayer.set(range.id, { firstSegment, segmentCount });
  }
  return { rangesByLayer };
}

/** Return the nearest move at or before the requested local move order. */
export function findPreviewMove(
  data: Pick<ToolpathGeometry, 'moveOrders'>,
  index: PreviewInspectionIndex,
  layer: number,
  move: number,
): number | null {
  const range = index.rangesByLayer.get(layer);
  if (!range) return null;
  let low = range.firstSegment;
  let high = range.firstSegment + range.segmentCount - 1;
  let best = range.firstSegment;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const order = data.moveOrders[middle] ?? 0;
    if (order <= move) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
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
