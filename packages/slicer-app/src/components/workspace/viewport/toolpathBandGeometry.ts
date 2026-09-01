import * as THREE from 'three';
import type { ClientToolpath } from '@slicer/client';
import type { PreviewVisibility } from './previewSemantics';

/** A layer-aligned range in the source segment stream. */
export interface ToolpathChunkRange {
  firstSegment: number;
  segmentCount: number;
  firstLayer: number;
  lastLayer: number;
}

/** A GPU-resident chunk and the source range it represents. */
export interface ToolpathBandChunk extends ToolpathChunkRange {
  geometry: THREE.InstancedBufferGeometry;
}

export interface PreparedToolpathBands {
  chunks: ToolpathBandChunk[];
  layerRanges: Array<[number, number]>;
  segmentCount: number;
  palette: ClientToolpath['palette'];
  /** Immutable source arrays retained for visibility and marker updates. */
  layerIds: Uint32Array;
  moveOrders: Uint32Array;
  features: Uint32Array;
  moveTypes: Uint8Array;
  ends: Float32Array;
  dispose: () => void;
}

/**
 * Keep the target as a soft limit: a chunk never cuts through a layer. This
 * makes layer-range changes a cheap instance-count/visibility update and
 * leaves the geometry stable while the camera moves.
 */
export const DEFAULT_TOOLPATH_CHUNK_TARGET = 16_384;

const CORNERS = new Float32Array([
  // endpoint, side, vertical; the index buffer below turns these corners into
  // the six faces of a small rectangular extrusion prism.
  0, -1, -1, 1, -1, -1, 1, 1, -1, 0, 1, -1,
  0, -1, 1, 1, -1, 1, 1, 1, 1, 0, 1, 1,
]);

const INDICES = new Uint16Array([
  0, 1, 2, 0, 2, 3,       // bottom
  4, 6, 5, 4, 7, 6,       // top
  0, 4, 5, 0, 5, 1,       // negative side
  3, 2, 6, 3, 6, 7,       // positive side
  0, 3, 7, 0, 7, 4,       // start cap
  1, 5, 6, 1, 6, 2,       // end cap
]);

function clampCount(count: number, length: number): number {
  return Math.max(0, Math.min(length, Math.floor(Number.isFinite(count) ? count : 0)));
}

/**
 * Derive contiguous layer runs from explicit segment layer ids. The bridge
 * emits layer-ordered data, but this routine also behaves safely for empty,
 * sparse, or malformed mock results.
 */
export function buildLayerAlignedChunkRanges(
  layerIds: Uint32Array,
  segmentCount = layerIds.length,
  target = DEFAULT_TOOLPATH_CHUNK_TARGET,
): ToolpathChunkRange[] {
  const count = clampCount(segmentCount, layerIds.length);
  if (count === 0) return [];
  const softTarget = Math.max(1, Math.floor(target));
  const layerRuns: ToolpathChunkRange[] = [];
  let layerStart = 0;
  let layer = layerIds[0] ?? 0;
  for (let i = 1; i <= count; i++) {
    const nextLayer = i < count ? layerIds[i] : undefined;
    if (nextLayer === layer) continue;
    // A layer is intentionally not split, even when it exceeds the target.
    // This is the key invariant used by the range and nearby-layer policies.
    layerRuns.push({
      firstSegment: layerStart,
      segmentCount: i - layerStart,
      firstLayer: layer,
      lastLayer: layer,
    });
    layerStart = i;
    layer = nextLayer ?? layer;
  }
  const chunks: ToolpathChunkRange[] = [];
  for (const run of layerRuns) {
    const previous = chunks.at(-1);
    if (previous && previous.segmentCount + run.segmentCount <= softTarget) {
      previous.segmentCount += run.segmentCount;
      previous.lastLayer = run.lastLayer;
    } else {
      chunks.push({ ...run });
    }
  }
  return chunks;
}

/** True while a chunk intersects an inclusive layer interval. */
export function chunkIntersectsLayerRange(
  chunk: ToolpathChunkRange,
  firstLayer: number,
  lastLayer: number,
): boolean {
  return chunk.lastLayer >= firstLayer && chunk.firstLayer <= lastLayer;
}

/**
 * Select chunks for the current inspection range. The legacy single-layer
 * scrubber remains the active interval until B3 introduces its dual-thumb
 * range. Camera gestures never change this selection: nearby chunks may be
 * GPU-resident cache entries, but they are not made visible by this policy.
 */
export function selectToolpathChunks(
  chunks: readonly ToolpathChunkRange[],
  firstLayer: number,
  lastLayer: number,
  segmentCount: number,
  cameraGestureActive: boolean,
  nearbyLayerRadius = 1,
): number[] {
  const active = chunks
    .map((chunk, index) => chunkIntersectsLayerRange(chunk, firstLayer, lastLayer) ? index : -1)
    .filter((index) => index >= 0);
  // These parameters are deliberately accepted for the future B3 visible /
  // active-range API. B2 has no wider visible range, so camera-only changes
  // must not expose paths outside the active interval.
  void segmentCount;
  void cameraGestureActive;
  void nearbyLayerRadius;
  return active;
}

function finitePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Create one instanced rectangular extrusion-band geometry. All per-segment
 * values are attributes; camera rotation only changes the shader's camera
 * uniform and never calls this function again.
 */
export function createToolpathBandChunk(
  starts: Float32Array,
  ends: Float32Array,
  widths: Float32Array,
  heights: Float32Array,
  colors: Float32Array,
  range: ToolpathChunkRange,
): ToolpathBandChunk {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('corner', new THREE.BufferAttribute(CORNERS, 3));
  geometry.setIndex(new THREE.BufferAttribute(INDICES, 1));

  const count = range.segmentCount;
  const start = starts.subarray(range.firstSegment * 3, (range.firstSegment + count) * 3);
  const end = ends.subarray(range.firstSegment * 3, (range.firstSegment + count) * 3);
  const width = new Float32Array(count);
  const height = new Float32Array(count);
  const color = colors.subarray(range.firstSegment * 3, (range.firstSegment + count) * 3);
  for (let i = 0; i < count; i++) {
    width[i] = finitePositive(widths[range.firstSegment + i], 0.08);
    height[i] = finitePositive(heights[range.firstSegment + i], 0.03);
  }
  geometry.setAttribute('instanceStart', new THREE.InstancedBufferAttribute(start, 3));
  geometry.setAttribute('instanceEnd', new THREE.InstancedBufferAttribute(end, 3));
  geometry.setAttribute('instanceWidth', new THREE.InstancedBufferAttribute(width, 1));
  geometry.setAttribute('instanceHeight', new THREE.InstancedBufferAttribute(height, 1));
  geometry.setAttribute('instanceColor', new THREE.InstancedBufferAttribute(color, 3));
  geometry.setAttribute('instanceVisibility', new THREE.InstancedBufferAttribute(new Float32Array(count).fill(1), 1));
  geometry.setAttribute('instanceDimmed', new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
  geometry.instanceCount = count;
  return { ...range, geometry };
}

/** Prepare all renderer-owned arrays for one immutable slice result. */
export function buildPreparedToolpathBands(t: ClientToolpath): PreparedToolpathBands {
  const segmentCount = Math.max(0, Math.min(
    t.segmentCount,
    Math.floor(t.starts.length / 3),
    Math.floor(t.ends.length / 3),
  ));
  const colors = new Float32Array(segmentCount * 3);
  for (let i = 0; i < segmentCount; i++) {
    const c = t.palette[t.features[i] ?? 0]?.color ?? [255, 255, 255];
    colors[i * 3] = c[0] / 255;
    colors[i * 3 + 1] = c[1] / 255;
    colors[i * 3 + 2] = c[2] / 255;
  }
  const chunkRanges = buildLayerAlignedChunkRanges(t.layerIds, segmentCount);
  const chunks = chunkRanges.map((range) => createToolpathBandChunk(
    t.starts, t.ends, t.widths, t.heights, colors, range,
  ));
  const layerRanges: Array<[number, number]> = [];
  if (segmentCount > 0) {
    let layerStart = 0;
    let layer = t.layerIds[0] ?? 0;
    for (let i = 1; i <= segmentCount; i++) {
      const nextLayer = i < segmentCount ? t.layerIds[i] : undefined;
      if (nextLayer === layer) continue;
      layerRanges[layer] = [layerStart, i - layerStart];
      layerStart = i;
      layer = nextLayer ?? layer;
    }
  }
  return {
    chunks,
    layerRanges,
    segmentCount,
    palette: t.palette,
    layerIds: t.layerIds,
    moveOrders: t.moveOrders,
    features: t.features,
    moveTypes: t.moveTypes,
    ends: t.ends,
    dispose: () => chunks.forEach((chunk) => chunk.geometry.dispose()),
  };
}

/** Update visibility/dimming attributes without replacing any geometry. */
export function updateToolpathChunkVisibility(
  chunks: readonly ToolpathBandChunk[],
  visibility: PreviewVisibility,
): void {
  chunks.forEach((chunk) => {
    const visibilityAttribute = chunk.geometry.getAttribute('instanceVisibility') as THREE.InstancedBufferAttribute;
    const dimmedAttribute = chunk.geometry.getAttribute('instanceDimmed') as THREE.InstancedBufferAttribute;
    for (let i = 0; i < chunk.segmentCount; i++) {
      const sourceIndex = chunk.firstSegment + i;
      visibilityAttribute.setX(i, visibility.visible[sourceIndex] ?? 0);
      dimmedAttribute.setX(i, visibility.dimmed[sourceIndex] ?? 0);
    }
    visibilityAttribute.needsUpdate = true;
    dimmedAttribute.needsUpdate = true;
    chunk.geometry.instanceCount = chunk.segmentCount;
  });
}

/**
 * Identity cache for the expensive result-to-GPU preparation step. Camera and
 * visibility state are intentionally absent from the key, so camera-only
 * rerenders cannot replace the prepared geometry.
 */
export class ToolpathBandCache {
  private source: ClientToolpath | null = null;
  private prepared: PreparedToolpathBands | null = null;
  buildCount = 0;

  prepare(source: ClientToolpath): PreparedToolpathBands {
    if (this.source === source && this.prepared) return this.prepared;
    this.source = source;
    this.prepared = buildPreparedToolpathBands(source);
    this.buildCount++;
    return this.prepared;
  }

  clear(): void {
    this.source = null;
    this.prepared = null;
  }
}

/** Shader for camera-facing rectangular bands with physical width/height. */
export function createToolpathBandMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { opacity: { value: 0.95 } },
    vertexShader: `
      attribute vec3 corner;
      attribute vec3 instanceStart;
      attribute vec3 instanceEnd;
      attribute float instanceWidth;
      attribute float instanceHeight;
      attribute vec3 instanceColor;
      attribute float instanceVisibility;
      attribute float instanceDimmed;
      varying vec3 vColor;
      varying float vDimmed;
      void main() {
        if (instanceVisibility < 0.5) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }
        vec3 segment = instanceEnd - instanceStart;
        float lengthSegment = max(length(segment), 0.00001);
        vec3 direction = segment / lengthSegment;
        vec3 center = mix(instanceStart, instanceEnd, corner.x);
        vec3 toCamera = normalize(cameraPosition - center);
        vec3 side = cross(direction, toCamera);
        if (length(side) < 0.0001) side = cross(direction, vec3(0.0, 0.0, 1.0));
        if (length(side) < 0.0001) side = vec3(1.0, 0.0, 0.0);
        side = normalize(side);
        vec3 worldPosition = center
          + side * corner.y * instanceWidth * 0.5
          + vec3(0.0, 0.0, corner.z * instanceHeight * 0.5);
        vColor = instanceColor;
        vDimmed = instanceDimmed;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPosition, 1.0);
      }
    `,
    fragmentShader: `
      uniform float opacity;
      varying vec3 vColor;
      varying float vDimmed;
      void main() { gl_FragColor = vec4(vColor, opacity * mix(1.0, 0.34, vDimmed)); }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}
