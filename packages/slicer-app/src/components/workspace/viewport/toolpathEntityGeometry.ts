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
  // Capped ends. Separate cap vertices keep the end normals planar.
  for (let i = 0; i < ring.length; i++) {
    const next = (i + 1) % ring.length;
    push(half, [0, 0]); push(half, ring[i]); push(half, ring[next]);
    push(-half, [0, 0]); push(-half, ring[next]); push(-half, ring[i]);
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
