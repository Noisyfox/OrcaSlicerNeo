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

/**
 * Build a physical diamond-band transform.  The template intentionally has
 * no endpoint faces: native libvgcode's pointy cap is hidden at a continuing
 * junction, while a flat face on every independent prism produces the dark
 * diamonds seen in the old adaptation.  Continuing segments overlap by half
 * their width at each shared endpoint, so removing those faces cannot create
 * a seam at a straight run or corner.
 */
export function buildToolpathEntityMatrix(
  start: THREE.Vector3,
  end: THREE.Vector3,
  width: number,
  height: number,
  options: ToolpathEntityMatrixOptions = {},
  target = new THREE.Matrix4(),
): THREE.Matrix4 {
  const axis = end.clone().sub(start);
  const length = axis.length();
  if (length > 1e-6) axis.multiplyScalar(1 / length);
  else axis.set(1, 0, 0);
  const halfWidth = Math.max(0, width) * 0.5;
  const adjustedStart = start.clone().addScaledVector(axis, options.extendStart ? -halfWidth : 0);
  const adjustedEnd = end.clone().addScaledVector(axis, options.extendEnd ? halfWidth : 0);
  const adjustedAxis = adjustedEnd.clone().sub(adjustedStart);
  const adjustedLength = Math.max(adjustedAxis.length(), 1e-5);
  adjustedAxis.multiplyScalar(1 / adjustedLength);
  const side = new THREE.Vector3().crossVectors(adjustedAxis, WORLD_UP);
  if (side.lengthSq() < 1e-12) side.crossVectors(X_AXIS, adjustedAxis);
  side.normalize();
  const up = new THREE.Vector3().crossVectors(side, adjustedAxis).normalize();
  const center = adjustedStart.add(adjustedEnd).multiplyScalar(0.5);
  if (Number.isFinite(options.bias)) center.z += options.bias!;
  return target.makeBasis(adjustedAxis, side, up)
    .scale(new THREE.Vector3(adjustedLength, Math.max(0, width), Math.max(0, height)))
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
