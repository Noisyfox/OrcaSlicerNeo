// packages/slicer-app/src/lib/cubeStl.ts
/**
 * Binary STL bytes for OrcaSlicer's Add Cube primitive: a 20 mm cube,
 * centered on the X/Y origin and resting on the build bed (Z 0..20).
 *
 * The cube is generated rather than shipped as a file so the shared app can
 * append it through the existing `runtime.addModel(bytes, 'stl')` path — the
 * bridge's post-import steps (`center_around_origin` + `ensure_on_bed`, see
 * bridge.cpp orc_add_model) land it exactly where OrcaSlicer's primitive
 * does, with no bridge or WASM changes.
 */

export const CUBE_SIZE_MM = 20;

const TRIANGLE_BYTES = 12 * 4 + 2; // normal (3) + vertices (9) + attribute

/**
 * 12 triangles of the cube, wound outward (positive signed volume). The
 * topology matches the fixture used across the repo's mock module, shifted
 * so the box spans -10..10 in X/Y and 0..20 in Z.
 */
const CUBE_TRIANGLES: ReadonlyArray<readonly [number, number, number]> = [
  // bottom (-Z)
  [0, 2, 1], [0, 3, 2],
  // top (+Z)
  [4, 5, 6], [4, 6, 7],
  // front (-Y)
  [0, 1, 5], [0, 5, 4],
  // right (+X)
  [1, 2, 6], [1, 6, 5],
  // back (+Y)
  [2, 3, 7], [2, 7, 6],
  // left (-X)
  [3, 0, 4], [3, 4, 7],
];

function cubeVertices(sizeMm: number): ReadonlyArray<readonly [number, number, number]> {
  const half = sizeMm / 2;
  return [
    [-half, -half, 0], [half, -half, 0], [half, half, 0], [-half, half, 0],
    [-half, -half, sizeMm], [half, -half, sizeMm], [half, half, sizeMm], [-half, half, sizeMm],
  ];
}

/** Binary STL (little-endian) for the 20 mm cube primitive. */
export function createCubeStl(): Uint8Array {
  const verts = cubeVertices(CUBE_SIZE_MM);
  const bytes = new Uint8Array(80 + 4 + CUBE_TRIANGLES.length * TRIANGLE_BYTES);
  const view = new DataView(bytes.buffer);
  new TextEncoder().encodeInto('OrcaSlicerNeo cube primitive', bytes);
  view.setUint32(80, CUBE_TRIANGLES.length, true);

  let offset = 84;
  for (const [ia, ib, ic] of CUBE_TRIANGLES) {
    const [ax, ay, az] = verts[ia];
    const [bx, by, bz] = verts[ib];
    const [cx, cy, cz] = verts[ic];
    // Face normal from the outward winding, normalized for the STL header.
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    view.setFloat32(offset, nx / len, true);
    view.setFloat32(offset + 4, ny / len, true);
    view.setFloat32(offset + 8, nz / len, true);
    offset += 12;
    for (const [x, y, z] of [verts[ia], verts[ib], verts[ic]]) {
      view.setFloat32(offset, x, true);
      view.setFloat32(offset + 4, y, true);
      view.setFloat32(offset + 8, z, true);
      offset += 12;
    }
    view.setUint16(offset, 0, true); // attribute byte count
    offset += 2;
  }
  return bytes;
}
