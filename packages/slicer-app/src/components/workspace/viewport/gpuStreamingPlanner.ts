import type { ClientToolpath, PreviewAnalysis, PreviewMetadata, PreviewPaletteEntry, PreviewToolpathMetrics, ToolpathFeature } from '@slicer/client';
import { TRAVEL_MOVE_TYPE } from './toolpathColors';

/** The soft page target agreed by the streaming renderer design. */
export const GPU_STREAMING_SOFT_PAGE_TARGET = 65_536;
/** Bytes in one RGBA32F/RGBA32UI texel. */
export const GPU_STREAMING_BYTES_PER_TEXEL = 16;
/** Bytes reserved by the dynamic R32UI enabled-index stream. */
export const GPU_STREAMING_BYTES_PER_INDEX = 4;

/**
 * The static schema reserved by the planner.  Four texels leave the exact
 * integer packing to the WebGL implementation while keeping the accounting
 * explicit and bounded: two endpoint texels, one shape texel, and one
 * categorical/identity texel.
 */
export interface GpuStreamingTexelSchema {
  endpointTexels: number;
  shapeTexels: number;
  identityTexels: number;
  paletteTexels: number;
  metricTexels: number;
  bytesPerTexel: number;
  texelsPerSegment: number;
  bytesPerStaticSegment: number;
}

export const DEFAULT_GPU_STREAMING_TEXEL_SCHEMA: Readonly<GpuStreamingTexelSchema> = Object.freeze({
  endpointTexels: 2,
  shapeTexels: 1,
  identityTexels: 1,
  paletteTexels: 0,
  metricTexels: 0,
  bytesPerTexel: GPU_STREAMING_BYTES_PER_TEXEL,
  texelsPerSegment: 4,
  bytesPerStaticSegment: 64,
});

export interface GpuStreamingLayerRange {
  id: number;
  firstSegment: number;
  segmentCount: number;
  z?: number;
}

/**
 * Source-neutral structure-of-arrays boundary consumed by the planner.  The
 * adapter retains the source typed arrays by reference; callers must treat
 * them as immutable for the lifetime of the returned plan.
 */
export interface GpuStreamingSource {
  readonly segmentCount: number;
  readonly starts: Float32Array;
  readonly ends: Float32Array;
  readonly widths: Float32Array;
  readonly heights: Float32Array;
  readonly layerIds: Uint32Array;
  readonly moveOrders: Uint32Array;
  readonly gcodeIds: Uint32Array;
  readonly moveTypes: Uint8Array;
  readonly extrusionRoles: Uint16Array;
  readonly extruderIds: Uint8Array;
  readonly colorPrintIds: Uint8Array;
  readonly features: Uint32Array;
  readonly palette: readonly ToolpathFeature[];
  readonly metrics: PreviewToolpathMetrics;
  readonly extruderPalette?: readonly PreviewPaletteEntry[];
  readonly analysis?: PreviewAnalysis;
  readonly layers: readonly GpuStreamingLayerRange[];
  /** Optional fields reserved by the source-neutral contract. */
  readonly angles?: Float32Array;
  readonly capAngles?: Float32Array;
  readonly biases?: Float32Array;
}

export interface GpuStreamingPage {
  readonly firstSegment: number;
  readonly segmentCount: number;
  readonly firstLayer: number;
  readonly lastLayer: number;
  /** True when a page is larger than the soft target or is a hard split. */
  readonly oversized: boolean;
  /** True when this page is one piece of a layer split by hard capacity. */
  readonly oversizedLayer: boolean;
  readonly atlasWidth: number;
  readonly atlasHeight: number;
  readonly atlasTexelCount: number;
  /** Physical geometry atlas dimensions for the three float texels/segment. */
  readonly geometryAtlasWidth: number;
  readonly geometryAtlasHeight: number;
  /** Physical identity atlas dimensions for the one integer texel/segment. */
  readonly identityAtlasWidth: number;
  readonly identityAtlasHeight: number;
  readonly geometryAtlasTexelCount: number;
  readonly identityAtlasTexelCount: number;
  readonly staticPaddingTexels: number;
  readonly estimatedStaticBytes: number;
  /** Upper-bound index allocation; actual enabled count is selection state. */
  readonly estimatedIndexCapacityBytes: number;
  readonly estimatedBytes: number;
  /** No GPU allocation is made by this module. */
  readonly allocatedBytes: null;
}

export interface GpuStreamingPlannerOptions {
  softPageTarget?: number;
  /** Explicit hard capacity supplied by a future WebGL capability query. */
  hardCapacity?: number;
  /** Optional future capability input; this planner never queries WebGL. */
  maxTextureSize?: number;
  texelSchema?: Partial<GpuStreamingTexelSchema>;
  /** Upper bound after static/index/page overhead. */
  gpuBudgetBytes?: number;
  pageOverheadBytes?: number;
  sharedTemplateBytes?: number;
}

export interface GpuStreamingPlanDiagnostics {
  readonly sourceSegmentCount: number;
  readonly pageCount: number;
  readonly softPageTarget: number;
  readonly hardCapacity: number | null;
  readonly oversizedPageCount: number;
  readonly oversizedLayerCount: number;
  readonly splitOversizedLayerCount: number;
  readonly estimatedStaticBytes: number;
  readonly estimatedIndexCapacityBytes: number;
  readonly estimatedBytes: number;
  readonly allocatedBytes: null;
  readonly budgetBytes: number | null;
  readonly budgetExceeded: boolean;
  readonly texelSchema: Readonly<GpuStreamingTexelSchema>;
}

export interface GpuStreamingPagePlan {
  readonly source: GpuStreamingSource;
  readonly pages: readonly GpuStreamingPage[];
  readonly layers: readonly GpuStreamingLayerRange[];
  readonly diagnostics: GpuStreamingPlanDiagnostics;
}

export interface GpuStreamingSelectionOptions {
  visibleLayerStart: number;
  visibleLayerEnd: number;
  activeMoveEnd: number;
  showTravel: boolean;
  visibility?: Readonly<Record<number, boolean>>;
  /** Selects the categorical id used by the scheme-scoped visibility map. */
  visibilityField?: 'feature' | 'filament';
}

export interface GpuStreamingPageSelection {
  readonly firstSegment: number;
  /** Local static IDs, suitable for the page's future R32UI stream. */
  readonly indices: Uint32Array;
  readonly emittedCount: number;
}

export interface GpuStreamingSelection {
  readonly pages: readonly GpuStreamingPageSelection[];
  readonly visitedSegments: number;
  readonly emittedSegments: number;
}

type ExtendedClientToolpath = ClientToolpath & {
  angles?: Float32Array;
  capAngles?: Float32Array;
  biases?: Float32Array;
};

function integer(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function validatedSegmentCount(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new RangeError('GPU streaming source segmentCount must be a non-negative integer');
  }
  return value;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Math.max(1, integer(value, fallback));
}

function finiteNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function freezeRange(range: GpuStreamingLayerRange): GpuStreamingLayerRange {
  return Object.freeze(range);
}

function deriveLayerRanges(
  layerIds: Uint32Array,
  count: number,
  metadataRanges?: readonly { id: number; z?: number }[],
): GpuStreamingLayerRange[] {
  const zById = new Map<number, number>();
  metadataRanges?.forEach((range) => {
    const z = finiteNumber(range.z);
    if (z !== undefined) zById.set(range.id, z);
  });
  const result: GpuStreamingLayerRange[] = [];
  if (count === 0) return result;
  let first = 0;
  let layer = layerIds[0] ?? 0;
  for (let end = 1; end <= count; end++) {
    const next = end < count ? layerIds[end] : undefined;
    if (next === layer) continue;
    result.push(freezeRange({
      id: layer,
      firstSegment: first,
      segmentCount: end - first,
      ...(zById.has(layer) ? { z: zById.get(layer) } : {}),
    }));
    first = end;
    layer = next ?? layer;
  }
  return result;
}

function ensureArrayLength(name: string, actual: number, expected: number): void {
  if (actual < expected) throw new RangeError(`ClientToolpath ${name} is shorter than segmentCount`);
}

function ensureMetricLengths(metrics: PreviewToolpathMetrics, expected: number): void {
  for (const [name, values] of Object.entries(metrics) as Array<[string, Float32Array | undefined]>) {
    // layerDuration is indexed by layer rather than by segment.
    if (name !== 'layerDuration' && values) ensureArrayLength(`metrics.${name}`, values.length, expected);
  }
}

/**
 * Adapt the existing WASM client result without copying shape or metadata
 * arrays. Layer ranges are small planner-owned metadata records; palette and
 * metric ownership remains with the source result.
 */
export function adaptClientToolpath(
  toolpath: ClientToolpath,
  metadata?: Pick<PreviewMetadata, 'layerRanges' | 'extruderPalette' | 'analysis'>,
): GpuStreamingSource {
  const count = validatedSegmentCount(toolpath.segmentCount);
  ensureArrayLength('starts', Math.floor(toolpath.starts.length / 3), count);
  ensureArrayLength('ends', Math.floor(toolpath.ends.length / 3), count);
  ensureArrayLength('widths', toolpath.widths.length, count);
  ensureArrayLength('heights', toolpath.heights.length, count);
  ensureArrayLength('layerIds', toolpath.layerIds.length, count);
  ensureArrayLength('moveOrders', toolpath.moveOrders.length, count);
  ensureArrayLength('gcodeIds', toolpath.gcodeIds.length, count);
  ensureArrayLength('moveTypes', toolpath.moveTypes.length, count);
  ensureArrayLength('extrusionRoles', toolpath.extrusionRoles.length, count);
  ensureArrayLength('extruderIds', toolpath.extruderIds.length, count);
  ensureArrayLength('colorPrintIds', toolpath.colorPrintIds.length, count);
  ensureArrayLength('features', toolpath.features.length, count);
  const extended = toolpath as ExtendedClientToolpath;
  if (extended.capAngles) ensureArrayLength('capAngles', extended.capAngles.length, count);
  if (extended.angles) ensureArrayLength('angles', extended.angles.length, count);
  ensureMetricLengths(toolpath.metrics, count);
  if (extended.biases) ensureArrayLength('biases', extended.biases.length, count);

  return Object.freeze({
    segmentCount: count,
    starts: toolpath.starts,
    ends: toolpath.ends,
    widths: toolpath.widths,
    heights: toolpath.heights,
    layerIds: toolpath.layerIds,
    moveOrders: toolpath.moveOrders,
    gcodeIds: toolpath.gcodeIds,
    moveTypes: toolpath.moveTypes,
    extrusionRoles: toolpath.extrusionRoles,
    extruderIds: toolpath.extruderIds,
    colorPrintIds: toolpath.colorPrintIds,
    features: toolpath.features,
    palette: toolpath.palette,
    metrics: toolpath.metrics,
    ...(metadata?.extruderPalette ? { extruderPalette: metadata.extruderPalette } : {}),
    ...(metadata?.analysis ? { analysis: metadata.analysis } : {}),
    layers: Object.freeze(deriveLayerRanges(toolpath.layerIds, count, metadata?.layerRanges)),
    ...(extended.angles ? { angles: extended.angles } : {}),
    ...(extended.capAngles ? { capAngles: extended.capAngles } : {}),
    ...(extended.biases ? { biases: extended.biases } : {}),
  });
}

/**
 * Validate and normalize the direct source API. The caller's layer table is
 * advisory metadata only: ranges are always regenerated from layerIds, so an
 * empty, gapped, overlapping, or mismatched table cannot drop or duplicate a
 * segment. The returned source owns a frozen layer table while retaining all
 * typed SoA buffers by reference.
 */
export function normalizeGpuStreamingSource(source: GpuStreamingSource): GpuStreamingSource {
  const count = validatedSegmentCount(source.segmentCount);
  ensureArrayLength('starts', Math.floor(source.starts.length / 3), count);
  ensureArrayLength('ends', Math.floor(source.ends.length / 3), count);
  ensureArrayLength('widths', source.widths.length, count);
  ensureArrayLength('heights', source.heights.length, count);
  ensureArrayLength('layerIds', source.layerIds.length, count);
  ensureArrayLength('moveOrders', source.moveOrders.length, count);
  ensureArrayLength('gcodeIds', source.gcodeIds.length, count);
  ensureArrayLength('moveTypes', source.moveTypes.length, count);
  ensureArrayLength('extrusionRoles', source.extrusionRoles.length, count);
  ensureArrayLength('extruderIds', source.extruderIds.length, count);
  ensureArrayLength('colorPrintIds', source.colorPrintIds.length, count);
  ensureArrayLength('features', source.features.length, count);
  if (source.angles) ensureArrayLength('angles', source.angles.length, count);
  if (source.capAngles) ensureArrayLength('capAngles', source.capAngles.length, count);
  if (source.biases) ensureArrayLength('biases', source.biases.length, count);
  ensureMetricLengths(source.metrics, count);
  for (let i = 1; i < count; i++) {
    if ((source.layerIds[i] ?? 0) < (source.layerIds[i - 1] ?? 0)) {
      throw new RangeError('GPU streaming source layerIds must be non-decreasing');
    }
  }
  const layers = Object.freeze(deriveLayerRanges(source.layerIds, count, source.layers));
  return Object.freeze({ ...source, segmentCount: count, layers });
}

function mergeSchema(options: GpuStreamingPlannerOptions): Readonly<GpuStreamingTexelSchema> {
  const values = {
    ...DEFAULT_GPU_STREAMING_TEXEL_SCHEMA,
    ...options.texelSchema,
  };
  const texelsPerSegment = values.endpointTexels + values.shapeTexels + values.identityTexels
    + values.paletteTexels + values.metricTexels;
  const bytesPerStaticSegment = texelsPerSegment * values.bytesPerTexel;
  if (!Number.isInteger(texelsPerSegment) || texelsPerSegment < 1 || bytesPerStaticSegment > 64) {
    throw new RangeError('GPU streaming static schema must fit the 64-byte segment budget');
  }
  return Object.freeze({ ...values, texelsPerSegment, bytesPerStaticSegment });
}

function atlasDimensions(texelCount: number, maxTextureSize: number | undefined): [number, number] {
  const max = maxTextureSize !== undefined && Number.isFinite(maxTextureSize) && maxTextureSize > 0
    ? Math.floor(maxTextureSize)
    : undefined;
  const width = Math.max(1, Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.ceil(Math.sqrt(texelCount))));
  return [width, Math.ceil(texelCount / width)];
}

function staticBytesForSegments(segmentCount: number, schema: GpuStreamingTexelSchema, maxTextureSize: number | undefined): number {
  const geometryTexels = segmentCount * (schema.endpointTexels + schema.shapeTexels);
  const identityTexels = segmentCount * schema.identityTexels;
  const [geometryWidth, geometryHeight] = atlasDimensions(geometryTexels, maxTextureSize);
  const [identityWidth, identityHeight] = atlasDimensions(identityTexels, maxTextureSize);
  return (geometryWidth * geometryHeight + identityWidth * identityHeight) * schema.bytesPerTexel;
}

function budgetCapacity(budget: number, schema: GpuStreamingTexelSchema, maxTextureSize: number | undefined, overhead: number): number {
  let low = 0;
  let high = Math.max(1, Math.floor(Math.max(0, budget - overhead) / (schema.bytesPerStaticSegment + GPU_STREAMING_BYTES_PER_INDEX)));
  while (staticBytesForSegments(high, schema, maxTextureSize) + high * GPU_STREAMING_BYTES_PER_INDEX > budget - overhead && high > 1) high = Math.floor(high / 2);
  if (staticBytesForSegments(high, schema, maxTextureSize) + high * GPU_STREAMING_BYTES_PER_INDEX > budget - overhead) return 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (staticBytesForSegments(middle, schema, maxTextureSize) + middle * GPU_STREAMING_BYTES_PER_INDEX <= budget - overhead) low = middle;
    else high = middle - 1;
  }
  return Math.max(1, low);
}

function hardCapacity(options: GpuStreamingPlannerOptions, schema: GpuStreamingTexelSchema): number | null {
  const candidates: number[] = [];
  if (options.hardCapacity !== undefined && Number.isFinite(options.hardCapacity)) {
    candidates.push(Math.floor(options.hardCapacity));
  }
  if (options.maxTextureSize !== undefined && Number.isFinite(options.maxTextureSize) && options.maxTextureSize > 0) {
    const max = Math.floor(options.maxTextureSize);
    // Float geometry is the dominant atlas (endpoint + shape texels). The
    // identity atlas has its own dimensions and therefore does not consume
    // the geometry texture's 4-texel/segment grid.
    candidates.push(Math.floor((max * max) / Math.max(1, schema.endpointTexels + schema.shapeTexels)));
  }
  if (options.gpuBudgetBytes !== undefined && Number.isFinite(options.gpuBudgetBytes)) {
    const budget = Math.max(0, options.gpuBudgetBytes);
    const overhead = Math.max(0, integer(options.pageOverheadBytes, 0))
      + Math.max(0, integer(options.sharedTemplateBytes, 0));
    candidates.push(budgetCapacity(budget, schema, options.maxTextureSize, overhead));
  }
  if (candidates.length === 0) return null;
  return Math.max(1, Math.min(...candidates));
}

function makePage(
  firstSegment: number,
  segmentCount: number,
  firstLayer: number,
  lastLayer: number,
  oversized: boolean,
  oversizedLayer: boolean,
  schema: GpuStreamingTexelSchema,
  maxTextureSize: number | undefined,
): GpuStreamingPage {
  const atlasTexelCount = segmentCount * schema.texelsPerSegment;
  const geometryTexelCount = segmentCount * (schema.endpointTexels + schema.shapeTexels);
  const identityTexelCount = segmentCount * schema.identityTexels;
  const [geometryAtlasWidth, geometryAtlasHeight] = atlasDimensions(geometryTexelCount, maxTextureSize);
  const [identityAtlasWidth, identityAtlasHeight] = atlasDimensions(identityTexelCount, maxTextureSize);
  const geometryAllocatedTexels = geometryAtlasWidth * geometryAtlasHeight;
  const identityAllocatedTexels = identityAtlasWidth * identityAtlasHeight;
  const staticPaddingTexels = geometryAllocatedTexels - geometryTexelCount + identityAllocatedTexels - identityTexelCount;
  const estimatedStaticBytes = (geometryAllocatedTexels + identityAllocatedTexels) * schema.bytesPerTexel;
  const estimatedIndexCapacityBytes = segmentCount * GPU_STREAMING_BYTES_PER_INDEX;
  return Object.freeze({
    firstSegment,
    segmentCount,
    firstLayer,
    lastLayer,
    oversized,
    oversizedLayer,
    // atlasWidth/Height remain the geometry atlas compatibility aliases.
    atlasWidth: geometryAtlasWidth,
    atlasHeight: geometryAtlasHeight,
    atlasTexelCount,
    geometryAtlasWidth,
    geometryAtlasHeight,
    identityAtlasWidth,
    identityAtlasHeight,
    geometryAtlasTexelCount: geometryAllocatedTexels,
    identityAtlasTexelCount: identityAllocatedTexels,
    staticPaddingTexels,
    estimatedStaticBytes,
    estimatedIndexCapacityBytes,
    estimatedBytes: estimatedStaticBytes + estimatedIndexCapacityBytes,
    allocatedBytes: null,
  });
}

/** Plan immutable layer-aligned static pages without allocating geometry. */
export function planGpuStreamingPages(
  source: GpuStreamingSource,
  options: GpuStreamingPlannerOptions = {},
): GpuStreamingPagePlan {
  const normalizedSource = normalizeGpuStreamingSource(source);
  const schema = mergeSchema(options);
  const softTarget = positiveInteger(options.softPageTarget, GPU_STREAMING_SOFT_PAGE_TARGET);
  const hard = hardCapacity(options, schema);
  const normalCapacity = Math.max(1, Math.min(softTarget, hard ?? softTarget));
  const pages: GpuStreamingPage[] = [];
  let pending: { first: number; count: number; firstLayer: number; lastLayer: number } | null = null;
  let oversizedLayerCount = 0;
  let splitOversizedLayerCount = 0;

  const flush = () => {
    if (!pending) return;
    pages.push(makePage(
      pending.first, pending.count, pending.firstLayer, pending.lastLayer,
      pending.count > softTarget, false, schema, options.maxTextureSize,
    ));
    pending = null;
  };

  for (const layer of normalizedSource.layers) {
    if (layer.segmentCount > softTarget) oversizedLayerCount++;
    if (hard !== null && layer.segmentCount > hard) {
      splitOversizedLayerCount++;
      flush();
      let cursor = layer.firstSegment;
      let remaining = layer.segmentCount;
      while (remaining > 0) {
        const count = Math.min(hard, remaining);
        pages.push(makePage(
          cursor, count, layer.id, layer.id, true, true, schema, options.maxTextureSize,
        ));
        cursor += count;
        remaining -= count;
      }
      continue;
    }
    if (!pending) {
      pending = { first: layer.firstSegment, count: layer.segmentCount, firstLayer: layer.id, lastLayer: layer.id };
    } else if (pending.count + layer.segmentCount <= normalCapacity) {
      pending.count += layer.segmentCount;
      pending.lastLayer = layer.id;
    } else {
      flush();
      pending = { first: layer.firstSegment, count: layer.segmentCount, firstLayer: layer.id, lastLayer: layer.id };
    }
  }
  flush();

  const estimatedStaticBytes = pages.reduce((sum, page) => sum + page.estimatedStaticBytes, 0);
  const estimatedIndexCapacityBytes = pages.reduce((sum, page) => sum + page.estimatedIndexCapacityBytes, 0);
  const estimatedBytes = estimatedStaticBytes + estimatedIndexCapacityBytes;
  const budgetBytes = options.gpuBudgetBytes !== undefined && Number.isFinite(options.gpuBudgetBytes)
    ? Math.max(0, options.gpuBudgetBytes) : null;
  return Object.freeze({
    source: normalizedSource,
    pages: Object.freeze(pages),
    layers: normalizedSource.layers,
    diagnostics: Object.freeze({
      sourceSegmentCount: source.segmentCount,
      pageCount: pages.length,
      softPageTarget: softTarget,
      hardCapacity: hard,
      oversizedPageCount: pages.filter((page) => page.oversized).length,
      oversizedLayerCount,
      splitOversizedLayerCount,
      estimatedStaticBytes,
      estimatedIndexCapacityBytes,
      estimatedBytes,
      allocatedBytes: null,
      budgetBytes,
      budgetExceeded: budgetBytes !== null && estimatedBytes > budgetBytes,
      texelSchema: schema,
    }),
  });
}

/** Convenience entry point for the current ClientToolpath contract. */
export function createGpuStreamingPagePlan(
  toolpath: ClientToolpath,
  metadata?: Pick<PreviewMetadata, 'layerRanges' | 'extruderPalette' | 'analysis'>,
  options: GpuStreamingPlannerOptions = {},
): GpuStreamingPagePlan {
  return planGpuStreamingPages(adaptClientToolpath(toolpath, metadata), options);
}

function visibleFeature(visibility: Readonly<Record<number, boolean>> | undefined, feature: number): boolean {
  return visibility?.[feature] !== false;
}

/**
 * Build page-local R32UI stream contents in source order. Each segment is
 * visited once and no segment-shaped object is allocated.
 */
export function rebuildGpuStreamingSelection(
  plan: GpuStreamingPagePlan,
  options: GpuStreamingSelectionOptions,
): GpuStreamingSelection {
  const source = plan.source;
  const maxLayer = source.layers.length > 0 ? source.layers[source.layers.length - 1]!.id : 0;
  const requestedStart = Math.max(0, integer(options.visibleLayerStart, 0));
  const requestedEnd = Math.max(requestedStart, integer(options.visibleLayerEnd, requestedStart));
  const layerStart = Math.min(maxLayer, requestedStart);
  const layerEnd = Math.min(maxLayer, Math.max(layerStart, requestedEnd));
  const moveEnd = Math.max(0, integer(options.activeMoveEnd, 0));
  const pages: GpuStreamingPageSelection[] = [];
  let emittedSegments = 0;
  let visitedSegments = 0;

  for (const page of plan.pages) {
    const indices = new Uint32Array(page.segmentCount);
    let emitted = 0;
    const end = page.firstSegment + page.segmentCount;
    for (let i = page.firstSegment; i < end; i++) {
      visitedSegments++;
      const layer = source.layerIds[i] ?? 0;
      if (layer < layerStart || layer > layerEnd) continue;
      if (layer === layerEnd && (source.moveOrders[i] ?? 0) > moveEnd) continue;
      if (!options.showTravel && (source.moveTypes[i] ?? 0) === TRAVEL_MOVE_TYPE) continue;
      const visibilityId = options.visibilityField === 'filament'
        ? source.extruderIds[i] ?? 0
        : source.features[i] ?? 0;
      if ((source.moveTypes[i] ?? 0) !== TRAVEL_MOVE_TYPE && !visibleFeature(options.visibility, visibilityId)) continue;
      indices[emitted++] = i - page.firstSegment;
    }
    pages.push(Object.freeze({ firstSegment: page.firstSegment, indices: indices.subarray(0, emitted), emittedCount: emitted }));
    emittedSegments += emitted;
  }
  return Object.freeze({ pages: Object.freeze(pages), visitedSegments, emittedSegments });
}
