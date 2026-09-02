import * as THREE from 'three';

/**
 * A unit-length, chamfered rectangular prism used for every toolpath entity.
 *
 * The chamfer is part of the physical mesh (not a screen-space outline): it
 * is 16% of each cross-section dimension and therefore scales with the
 * segment's width/height matrix.  The eight longitudinal facets provide a
 * stable edge highlight between adjacent same-colour paths while preserving
 * the requested continuous solid volume.
 */
export const TOOLPATH_ENTITY_CHAMFER_RATIO = 0.16;

export function createToolpathEntityGeometry(): THREE.BufferGeometry {
  const ratio = TOOLPATH_ENTITY_CHAMFER_RATIO;
  const half = 0.5;
  const inset = half * ratio;
  // Counter-clockwise in the local Y/Z plane when viewed from +X.
  const ring: ReadonlyArray<readonly [number, number]> = [
    [-half + inset, -half], [half - inset, -half],
    [half, -half + inset], [half, half - inset],
    [half - inset, half], [-half + inset, half],
    [-half, half - inset], [-half, -half + inset],
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
