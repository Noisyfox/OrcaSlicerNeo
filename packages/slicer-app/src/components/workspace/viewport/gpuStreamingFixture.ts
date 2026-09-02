/**
 * Metadata-only fixture for the GPU streaming renderer design.
 *
 * Deliberately absent: endpoints, widths/heights, Three.js objects and WebGL
 * resources. The later renderer benchmark may use this metadata to exercise a
 * planner, but this module must stay cheap enough for ordinary unit tests.
 */

export const GPU_STREAM_SEGMENT_COUNTS = [250_000, 1_000_000] as const;
export const GPU_STREAM_FIXTURE_SEED = 0x51_7a_93_2d;
export const GPU_STREAM_FIXTURE_LAYER_COUNT = 256;
export const GPU_STREAM_PAGE_TARGET = 65_536;

/** EMoveType::Travel in the existing preview v2 bridge contract. */
export const GPU_STREAM_TRAVEL_MOVE_TYPE = 8;
/** A deterministic extrusion move type used by the fixture. */
export const GPU_STREAM_EXTRUSION_MOVE_TYPE = 10;

export interface GpuStreamingPage {
  firstSegment: number;
  segmentCount: number;
  firstLayer: number;
  lastLayer: number;
}

export interface GpuStreamingMetadata {
  segmentCount: number;
  layerCount: number;
  seed: number;
  pageTarget: number;
  layerIds: Uint32Array;
  moveOrders: Uint32Array;
  /** Compact feature IDs; no palette or colour objects are allocated. */
  features: Uint8Array;
  moveTypes: Uint8Array;
  pages: readonly GpuStreamingPage[];
}

export interface GpuStreamingFixtureOptions {
  segmentCount: number;
  seed?: number;
  layerCount?: number;
  pageTarget?: number;
}

export interface GpuStreamingSelectionOptions {
  visibleLayerStart: number;
  visibleLayerEnd: number;
  activeMoveEnd: number;
  showTravel: boolean;
  featureVisibility?: Readonly<Record<number, boolean>>;
}

export interface GpuStreamingSelection {
  /** Local source IDs in stable source order; this is the future index stream. */
  indices: Uint32Array;
  /** Exactly how many metadata records the predicate inspected. */
  visitedSegments: number;
  emittedSegments: number;
}

function finiteInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Build layer-aligned pages without touching geometry. A normal synthetic
 * layer is never split, even when a page reaches the soft target.
 */
export function buildGpuStreamingPages(
  layerIds: Uint32Array,
  segmentCount = layerIds.length,
  pageTarget = GPU_STREAM_PAGE_TARGET,
): GpuStreamingPage[] {
  const count = clamp(finiteInt(segmentCount, 0), 0, layerIds.length);
  const target = Math.max(1, finiteInt(pageTarget, GPU_STREAM_PAGE_TARGET));
  if (count === 0) return [];

  const pages: GpuStreamingPage[] = [];
  let layerStart = 0;
  let layer = layerIds[0] ?? 0;
  for (let end = 1; end <= count; end++) {
    const nextLayer = end < count ? layerIds[end] : undefined;
    if (nextLayer === layer) continue;
    const runCount = end - layerStart;
    const previous = pages.at(-1);
    if (previous && previous.segmentCount + runCount <= target) {
      previous.segmentCount += runCount;
      previous.lastLayer = layer;
    } else {
      pages.push({
        firstSegment: layerStart,
        segmentCount: runCount,
        firstLayer: layer,
        lastLayer: layer,
      });
    }
    layerStart = end;
    layer = nextLayer ?? layer;
  }
  return pages;
}

/**
 * Generate deterministic segment metadata for the two renderer stress sizes.
 * The only per-segment allocations are compact typed arrays needed for
 * selection semantics; no mock geometry is built.
 */
export function createGpuStreamingMetadata(options: GpuStreamingFixtureOptions): GpuStreamingMetadata {
  const segmentCount = Math.max(0, finiteInt(options.segmentCount, 0));
  const layerCount = Math.max(1, finiteInt(options.layerCount, GPU_STREAM_FIXTURE_LAYER_COUNT));
  const seed = (finiteInt(options.seed, GPU_STREAM_FIXTURE_SEED) >>> 0);
  const pageTarget = Math.max(1, finiteInt(options.pageTarget, GPU_STREAM_PAGE_TARGET));

  const layerIds = new Uint32Array(segmentCount);
  const moveOrders = new Uint32Array(segmentCount);
  const features = new Uint8Array(segmentCount);
  const moveTypes = new Uint8Array(segmentCount);
  let currentLayer = -1;
  let moveOrder = 0;
  let state = seed;
  for (let i = 0; i < segmentCount; i++) {
    const layer = Math.min(layerCount - 1, Math.floor((i * layerCount) / Math.max(1, segmentCount)));
    if (layer !== currentLayer) {
      currentLayer = layer;
      moveOrder = 0;
    }
    layerIds[i] = layer;
    moveOrders[i] = moveOrder++;

    // Fixed xorshift32 sequence gives stable categories without Math.random.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    features[i] = state % 4;
    moveTypes[i] = state % 13 === 0 ? GPU_STREAM_TRAVEL_MOVE_TYPE : GPU_STREAM_EXTRUSION_MOVE_TYPE;
  }

  return {
    segmentCount,
    layerCount,
    seed,
    pageTarget,
    layerIds,
    moveOrders,
    features,
    moveTypes,
    pages: buildGpuStreamingPages(layerIds, segmentCount, pageTarget),
  };
}

function featureIsVisible(
  visibility: Readonly<Record<number, boolean>> | undefined,
  feature: number,
): boolean {
  return visibility?.[feature] !== false;
}

/**
 * Build the future enabled-index stream in one linear metadata pass. The
 * maximum-sized temporary is 4 bytes per segment (the index stream itself),
 * never a full set of GPU geometry attributes.
 */
export function rebuildGpuStreamingSelection(
  metadata: Pick<GpuStreamingMetadata, 'segmentCount' | 'layerIds' | 'moveOrders' | 'features' | 'moveTypes'>,
  options: GpuStreamingSelectionOptions,
): GpuStreamingSelection {
  const count = clamp(finiteInt(metadata.segmentCount, 0), 0, metadata.layerIds.length);
  const layerStart = Math.max(0, finiteInt(options.visibleLayerStart, 0));
  const layerEnd = Math.max(layerStart, finiteInt(options.visibleLayerEnd, layerStart));
  const moveEnd = Math.max(0, finiteInt(options.activeMoveEnd, 0));
  const indices = new Uint32Array(count);
  let emittedSegments = 0;

  for (let i = 0; i < count; i++) {
    const layer = metadata.layerIds[i] ?? 0;
    if (layer < layerStart || layer > layerEnd) continue;
    if (layer === layerEnd && (metadata.moveOrders[i] ?? 0) > moveEnd) continue;
    if (!options.showTravel && metadata.moveTypes[i] === GPU_STREAM_TRAVEL_MOVE_TYPE) continue;
    if (!featureIsVisible(options.featureVisibility, metadata.features[i] ?? 0)) continue;
    indices[emittedSegments++] = i;
  }

  return {
    indices: indices.subarray(0, emittedSegments),
    visitedSegments: count,
    emittedSegments,
  };
}
