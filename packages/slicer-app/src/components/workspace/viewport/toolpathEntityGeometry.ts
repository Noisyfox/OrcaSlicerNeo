import * as THREE from 'three';

/**
 * The shared toolpath profile used by both the streaming and B2 renderers.
 *
 * Native libvgcode's SegmentTemplate has cardinal endpoint vertices on
 * `line_right`/`line_up` (see the sign table in Shaders.hpp), which gives a
 * diamond rather than a square or chamfered cross-section.  Keep that profile
 * in real geometry so width/height remain instance-matrix dimensions and no
 * renderer-specific shader can change the visible shape.
 */
export const TOOLPATH_ENTITY_PROFILE = 'diamond' as const;

/** Unit cross-section half extents in the local side/up plane. */
export const TOOLPATH_ENTITY_DIAMOND_HALF_EXTENT = 0.5;
const WORLD_UP = new THREE.Vector3(0, 0, 1);
const X_AXIS = new THREE.Vector3(1, 0, 0);

/** Native-style continuity guard used to hide caps at real move junctions. */
export function isToolpathSegmentContinuous(
  starts: Float32Array,
  ends: Float32Array,
  first: number,
  second: number,
  layerIds?: Uint32Array,
  moveTypes?: Uint8Array,
): boolean {
  if (first < 0 || second < 0 || first >= Math.floor(ends.length / 3) || second >= Math.floor(starts.length / 3)) return false;
  // Without the source categories we cannot prove this is a native-style
  // continuing move (rather than a travel/extrusion or layer boundary).
  if (!layerIds || !moveTypes) return false;
  if (layerIds[first] !== layerIds[second]) return false;
  if (moveTypes[first] !== moveTypes[second]) return false;
  const offset = first * 3;
  const next = second * 3;
  const dx = (ends[offset] ?? 0) - (starts[next] ?? 0);
  const dy = (ends[offset + 1] ?? 0) - (starts[next + 1] ?? 0);
  const dz = (ends[offset + 2] ?? 0) - (starts[next + 2] ?? 0);
  return dx * dx + dy * dy + dz * dz <= 1e-10;
}

export interface ToolpathEntityMatrixOptions {
  /** Extend this end into the adjacent entity so their open side surfaces overlap. */
  readonly extendStart?: boolean;
  readonly extendEnd?: boolean;
  readonly bias?: number;
}

export interface ToolpathEntityScratch {
  readonly normalized: THREE.Vector3;
  readonly side: THREE.Vector3;
  readonly up: THREE.Vector3;
  readonly axis: THREE.Vector3;
  readonly start: THREE.Vector3;
  readonly end: THREE.Vector3;
  readonly adjustedStart: THREE.Vector3;
  readonly adjustedEnd: THREE.Vector3;
  readonly adjustedAxis: THREE.Vector3;
  readonly center: THREE.Vector3;
  readonly scale: THREE.Vector3;
  readonly color: THREE.Color;
  readonly matrix: THREE.Matrix4;
}

export function createToolpathEntityScratch(): ToolpathEntityScratch {
  return {
    normalized: new THREE.Vector3(), side: new THREE.Vector3(), up: new THREE.Vector3(), axis: new THREE.Vector3(),
    start: new THREE.Vector3(), end: new THREE.Vector3(), adjustedStart: new THREE.Vector3(), adjustedEnd: new THREE.Vector3(),
    adjustedAxis: new THREE.Vector3(), center: new THREE.Vector3(), scale: new THREE.Vector3(), color: new THREE.Color(), matrix: new THREE.Matrix4(),
  };
}

function buildBasis(axis: THREE.Vector3, scratch?: ToolpathEntityScratch): { axis: THREE.Vector3; side: THREE.Vector3; up: THREE.Vector3 } {
  const normalized = scratch?.normalized ?? new THREE.Vector3();
  if (axis.lengthSq() > 1e-12) normalized.copy(axis).normalize();
  else normalized.set(1, 0, 0);
  const side = scratch?.side ?? new THREE.Vector3();
  side.crossVectors(normalized, WORLD_UP);
  if (side.lengthSq() < 1e-12) side.crossVectors(X_AXIS, normalized);
  side.normalize();
  const up = scratch?.up ?? new THREE.Vector3();
  up.crossVectors(side, normalized).normalize();
  return { axis: normalized, side, up };
}

/** Build a physical diamond-band transform. The shared template carries the
 * pointy spikes; adjacency flags only control the half-width body overlap. */
export function buildToolpathEntityMatrix(
  start: THREE.Vector3,
  end: THREE.Vector3,
  width: number,
  height: number,
  options: ToolpathEntityMatrixOptions = {},
  target = new THREE.Matrix4(),
  scratch?: ToolpathEntityScratch,
): THREE.Matrix4 {
  const rawAxis = scratch?.axis ?? new THREE.Vector3();
  rawAxis.subVectors(end, start);
  const length = rawAxis.length();
  const axis = length > 1e-6 ? rawAxis.multiplyScalar(1 / length) : (scratch?.normalized ?? new THREE.Vector3()).set(1, 0, 0);
  const halfWidth = Math.max(0, width) * 0.5;
  const adjustedStart = scratch?.adjustedStart ?? new THREE.Vector3();
  adjustedStart.copy(start).addScaledVector(axis, options.extendStart ? -halfWidth : 0);
  const adjustedEnd = scratch?.adjustedEnd ?? new THREE.Vector3();
  adjustedEnd.copy(end).addScaledVector(axis, options.extendEnd ? halfWidth : 0);
  const adjustedAxis = scratch?.adjustedAxis ?? new THREE.Vector3();
  adjustedAxis.subVectors(adjustedEnd, adjustedStart);
  const adjustedLength = Math.max(adjustedAxis.length(), 1e-5);
  adjustedAxis.multiplyScalar(1 / adjustedLength);
  const basis = buildBasis(adjustedAxis, scratch);
  const center = scratch?.center ?? new THREE.Vector3();
  center.addVectors(adjustedStart, adjustedEnd).multiplyScalar(0.5);
  if (Number.isFinite(options.bias)) center.z += options.bias!;
  const scale = scratch?.scale ?? new THREE.Vector3();
  scale.set(adjustedLength, Math.max(0, width), Math.max(0, height));
  return target.makeBasis(basis.axis, basis.side, basis.up)
    .scale(scale)
    .setPosition(center);
}

export function createToolpathEntityGeometry(): THREE.BufferGeometry {
  const half = 0.5;
  // Counter-clockwise cardinal points in the local Y/Z plane when viewed from
  // +X.  This is the native line_right/line_up profile, not an outline pass.
  const ring: ReadonlyArray<readonly [number, number]> = [
    [0, -half], [half, 0], [0, half], [-half, 0],
  ];
  const positions: number[] = [];
  const push = (x: number, yz: readonly [number, number]) => positions.push(x, yz[0], yz[1]);
  const pushQuad = (a: [number, readonly [number, number]], b: [number, readonly [number, number]], c: [number, readonly [number, number]], d: [number, readonly [number, number]]) => {
    push(a[0], a[1]); push(b[0], b[1]); push(c[0], c[1]);
    push(a[0], a[1]); push(c[0], c[1]); push(d[0], d[1]);
  };
  // Longitudinal facets. Reversing the ring edge gives outward normals.
  for (let i = 0; i < ring.length; i++) {
    const next = (i + 1) % ring.length;
    pushQuad([-half, ring[next]], [half, ring[next]], [half, ring[i]], [-half, ring[i]]);
  }
  // SegmentTemplate carries both pointy endpoint spikes in the shared entity
  // template. They are deliberately not separate cap meshes: selection only
  // changes the enabled instance slot, so a layer drag never rebuilds cap
  // resources. Continuing entities overlap at their junction and cover the
  // inward spike, matching native SegmentTemplate behavior.
  for (const direction of [-1, 1] as const) {
    for (let i = 0; i < ring.length; i++) {
      const next = (i + 1) % ring.length;
      const base = direction * half;
      const apex = direction;
      if (direction < 0) {
        push(apex, [0, 0]); push(base, ring[next]); push(base, ring[i]);
      } else {
        push(apex, [0, 0]); push(base, ring[i]); push(base, ring[next]);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export function createToolpathEntityMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    // InstancedMesh supplies instanceColor; the geometry intentionally has no
    // per-vertex color attribute (enabling vertexColors would multiply by a
    // missing zero-valued attribute and make every path black).
    vertexColors: false,
    color: 0xffffff,
    flatShading: true,
    roughness: 0.82,
    metalness: 0,
    // Transparent queue ordering only; blending remains explicitly disabled.
    transparent: true,
    opacity: 1,
    blending: THREE.NoBlending,
    depthTest: true,
    depthWrite: true,
    side: THREE.FrontSide,
  });
  material.forceSinglePass = true;
  return material;
}
