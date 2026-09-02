import * as THREE from 'three';
import type { ClientToolpath } from '@slicer/client';
import type { PreviewVisibility } from './previewSemantics';
import { buildToolpathEntityMatrix, createToolpathEntityGeometry, createToolpathEntityMaterial, createToolpathEntityScratch, isToolpathSegmentContinuous, type ToolpathEntityScratch } from './toolpathEntityGeometry';
import { resolveToolpathColor, TOOLPATH_FALLBACK_COLOR } from './toolpathColors';

export interface ToolpathChunkRange {
  firstSegment: number;
  segmentCount: number;
  firstLayer: number;
  lastLayer: number;
}
export interface ToolpathVisibilityUpdateRange {
  readonly firstLayer: number;
  readonly lastLayer: number;
}

/** A layer-aligned solid entity collection used by the B2 fallback. */
export interface ToolpathBandChunk extends ToolpathChunkRange {
  geometry: THREE.BufferGeometry;
  mesh: THREE.InstancedMesh;
  /** Original matrices/colors let visibility rebuild without parsing G-code. */
  instanceMatrices: THREE.Matrix4[];
  instanceColors: THREE.Color[];
  starts: Float32Array;
  ends: Float32Array;
  widths: Float32Array;
  heights: Float32Array;
  layerIds?: Uint32Array;
  moveTypes?: Uint8Array;
  /** Last applied state; range updates only touch changed segments. */
  visibility: Uint8Array;
  dimmed: Uint8Array;
  readonly scratch: ToolpathEntityScratch;
  /** Diagnostics for regression/performance tests. */
  lastUpdatedSegmentCount: number;
  lastRebuiltCapSegmentCount: number;
}
export interface PreparedToolpathBands {
  chunks: ToolpathBandChunk[];
  layerRanges: Array<[number, number]>;
  segmentCount: number;
  palette: ClientToolpath['palette'];
  layerIds: Uint32Array;
  moveOrders: Uint32Array;
  features: Uint32Array;
  moveTypes: Uint8Array;
  ends: Float32Array;
  dispose: () => void;
}
export const DEFAULT_TOOLPATH_CHUNK_TARGET = 16_384;
function finitePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}
function buildMatrix(starts: Float32Array, ends: Float32Array, widths: Float32Array, heights: Float32Array, layerIds: Uint32Array | undefined, moveTypes: Uint8Array | undefined, index: number): THREE.Matrix4 {
  const start = new THREE.Vector3(starts[index * 3] ?? 0, starts[index * 3 + 1] ?? 0, starts[index * 3 + 2] ?? 0);
  const end = new THREE.Vector3(ends[index * 3] ?? start.x, ends[index * 3 + 1] ?? start.y, ends[index * 3 + 2] ?? start.z);
  return buildToolpathEntityMatrix(start, end, finitePositive(widths[index], 0.08), finitePositive(heights[index], 0.03), {
    extendStart: isToolpathSegmentContinuous(starts, ends, index - 1, index, layerIds, moveTypes),
    extendEnd: isToolpathSegmentContinuous(starts, ends, index, index + 1, layerIds, moveTypes),
  });
}
function createMaterial(): THREE.MeshStandardMaterial { return createToolpathEntityMaterial(); }
function clampCount(count: number, length: number): number {
  return Math.max(0, Math.min(length, Math.floor(Number.isFinite(count) ? count : 0)));
}
export function buildLayerAlignedChunkRanges(layerIds: Uint32Array, segmentCount = layerIds.length, target = DEFAULT_TOOLPATH_CHUNK_TARGET): ToolpathChunkRange[] {
  const count = clampCount(segmentCount, layerIds.length);
  if (count === 0) return [];
  const softTarget = Math.max(1, Math.floor(target));
  const runs: ToolpathChunkRange[] = [];
  let first = 0;
  let layer = layerIds[0] ?? 0;
  for (let i = 1; i <= count; i++) {
    const next = i < count ? layerIds[i] : undefined;
    if (next === layer) continue;
    runs.push({ firstSegment: first, segmentCount: i - first, firstLayer: layer, lastLayer: layer });
    first = i;
    layer = next ?? layer;
  }
  const chunks: ToolpathChunkRange[] = [];
  for (const run of runs) {
    const previous = chunks.at(-1);
    if (previous && previous.segmentCount + run.segmentCount <= softTarget) {
      previous.segmentCount += run.segmentCount;
      previous.lastLayer = run.lastLayer;
    } else chunks.push({ ...run });
  }
  return chunks;
}
export function chunkIntersectsLayerRange(chunk: ToolpathChunkRange, firstLayer: number, lastLayer: number): boolean {
  return chunk.lastLayer >= firstLayer && chunk.firstLayer <= lastLayer;
}
export function selectToolpathChunks(chunks: readonly ToolpathChunkRange[], firstLayer: number, lastLayer: number, segmentCount: number, cameraGestureActive: boolean, nearbyLayerRadius = 1): number[] {
  void segmentCount; void cameraGestureActive; void nearbyLayerRadius;
  return chunks.map((chunk, index) => chunkIntersectsLayerRange(chunk, firstLayer, lastLayer) ? index : -1).filter((index) => index >= 0);
}

/** Create physical diamond side bands, with width/height/direction in each matrix. */
export function createToolpathBandChunk(starts: Float32Array, ends: Float32Array, widths: Float32Array, heights: Float32Array, colors: Float32Array, range: ToolpathChunkRange, layerIds?: Uint32Array, moveTypes?: Uint8Array): ToolpathBandChunk {
  const geometry = createToolpathEntityGeometry();
  const mesh = new THREE.InstancedMesh(geometry, createMaterial(), range.segmentCount);
  mesh.count = range.segmentCount;
  mesh.frustumCulled = false;
  mesh.renderOrder = 1000;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const instanceMatrices: THREE.Matrix4[] = [];
  const instanceColors: THREE.Color[] = [];
  for (let i = 0; i < range.segmentCount; i++) {
    const source = range.firstSegment + i;
    const matrix = buildMatrix(starts, ends, widths, heights, layerIds, moveTypes, source);
    const color = new THREE.Color(colors[source * 3] ?? TOOLPATH_FALLBACK_COLOR[0], colors[source * 3 + 1] ?? TOOLPATH_FALLBACK_COLOR[1], colors[source * 3 + 2] ?? TOOLPATH_FALLBACK_COLOR[2]);
    instanceMatrices.push(matrix);
    instanceColors.push(color);
    mesh.setMatrixAt(i, matrix);
    mesh.setColorAt(i, color);
  }
  const chunk: ToolpathBandChunk = {
    ...range, geometry, mesh, instanceMatrices, instanceColors, starts, ends, widths, heights, layerIds, moveTypes,
    visibility: Uint8Array.from({ length: range.segmentCount }, () => 1), dimmed: new Uint8Array(range.segmentCount),
    scratch: createToolpathEntityScratch(),
    lastUpdatedSegmentCount: 0, lastRebuiltCapSegmentCount: 0,
  };
  chunk.mesh.instanceMatrix.needsUpdate = true;
  if (chunk.mesh.instanceColor) chunk.mesh.instanceColor.needsUpdate = true;
  return chunk;
}
export function buildPreparedToolpathBands(t: ClientToolpath): PreparedToolpathBands {
  const segmentCount = Math.max(0, Math.min(t.segmentCount, Math.floor(t.starts.length / 3), Math.floor(t.ends.length / 3)));
  const colors = new Float32Array(segmentCount * 3);
  for (let i = 0; i < segmentCount; i++) {
    const normalized = resolveToolpathColor(t.palette, t.features[i] ?? 0, t.moveTypes[i] ?? 0);
    colors[i * 3] = normalized[0]; colors[i * 3 + 1] = normalized[1]; colors[i * 3 + 2] = normalized[2];
  }
  const chunks = buildLayerAlignedChunkRanges(t.layerIds, segmentCount).map((range) => createToolpathBandChunk(t.starts, t.ends, t.widths, t.heights, colors, range, t.layerIds, t.moveTypes));
  const layerRanges: Array<[number, number]> = [];
  for (const chunk of chunks) layerRanges[chunk.firstLayer] = [chunk.firstSegment, chunk.segmentCount];
  return { chunks, layerRanges, segmentCount, palette: t.palette, layerIds: t.layerIds, moveOrders: t.moveOrders, features: t.features, moveTypes: t.moveTypes, ends: t.ends, dispose: () => chunks.forEach((chunk) => {
    (chunk.mesh.material as THREE.Material).dispose();
    chunk.geometry.dispose();
  }) };
}
/** Apply hide semantics with real matrices/colors; no shader visibility discard. */
function updateToolpathBandChunkVisibility(chunk: ToolpathBandChunk, visibility: PreviewVisibility): void {
  const scratch = chunk.scratch;
  let updated = 0;
  for (let i = 0; i < chunk.segmentCount; i++) {
    const source = chunk.firstSegment + i;
    const nextVisible = (visibility.visible[source] ?? 0) !== 0 ? 1 : 0;
    const nextDimmed = (visibility.dimmed[source] ?? 0) !== 0 ? 1 : 0;
    const visibilityChanged = nextVisible !== chunk.visibility[i];
    const dimmingChanged = nextDimmed !== chunk.dimmed[i];
    if (!visibilityChanged && !dimmingChanged) continue;
    chunk.visibility[i] = nextVisible;
    chunk.dimmed[i] = nextDimmed;
    updated++;
    const matrix = chunk.instanceMatrices[i]!;
    if (visibilityChanged) {
      if (nextVisible) chunk.mesh.setMatrixAt(i, matrix);
      else chunk.mesh.setMatrixAt(i, scratch.matrix.makeScale(0, 0, 0));
    }
    const color = scratch.color.copy(chunk.instanceColors[i]!);
    if (nextDimmed) color.multiplyScalar(0.34);
    chunk.mesh.setColorAt(i, color);
  }
  chunk.lastRebuiltCapSegmentCount = 0;
  chunk.lastUpdatedSegmentCount = updated;
  chunk.mesh.count = chunk.segmentCount;
  chunk.mesh.instanceMatrix.needsUpdate = true;
  if (chunk.mesh.instanceColor) chunk.mesh.instanceColor.needsUpdate = true;
}
/*
 * The old implementation rebuilt a compact cap InstancedMesh here. Endpoint
 * spikes now live in the shared SegmentTemplate geometry, so this update is
 * intentionally limited to enabled instance transforms and colors.
 */
export function updateToolpathChunkVisibility(chunks: readonly ToolpathBandChunk[], visibility: PreviewVisibility, range?: ToolpathVisibilityUpdateRange): void {
  chunks.forEach((chunk) => {
    if (range && !chunkIntersectsLayerRange(chunk, range.firstLayer, range.lastLayer)) return;
    updateToolpathBandChunkVisibility(chunk, visibility);
  });
}
export class ToolpathBandCache {
  private source: ClientToolpath | null = null;
  private prepared: PreparedToolpathBands | null = null;
  buildCount = 0;
  prepare(source: ClientToolpath): PreparedToolpathBands {
    if (this.source === source && this.prepared) return this.prepared;
    this.source = source; this.prepared = buildPreparedToolpathBands(source); this.buildCount++; return this.prepared;
  }
  clear(): void { this.source = null; this.prepared = null; }
}
