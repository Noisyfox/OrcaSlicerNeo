// Bracket geometry for the aggregate selection bounding box, matching the
// native OrcaSlicer rendering (Selection::render_bounding_box): at every
// corner, three short segments run inward along each axis, each 20% of the
// box size along that axis. See doc/2026-08-22-viewport-selection-box.md.
import * as THREE from 'three';

export const SELECTION_BOX_BRACKET_FRACTION = 0.2;

const CORNERS = (
  min: THREE.Vector3,
  max: THREE.Vector3,
): Array<[number, number, number]> => [
  [min.x, min.y, min.z],
  [max.x, min.y, min.z],
  [max.x, max.y, min.z],
  [min.x, max.y, min.z],
  [min.x, min.y, max.z],
  [max.x, min.y, max.z],
  [max.x, max.y, max.z],
  [min.x, max.y, max.z],
];

/**
 * 24 line segments (48 vertices, 144 XYZ floats) — three inward brackets per
 * corner. A degenerate axis produces zero-length brackets, exactly like the
 * native code.
 */
export function selectionBoundsBoxPositions(bounds: THREE.Box3): Float32Array {
  const { min, max } = bounds;
  const size = bounds.getSize(new THREE.Vector3());
  const bracket = size.multiplyScalar(SELECTION_BOX_BRACKET_FRACTION);
  const positions = new Float32Array(48 * 3);
  let offset = 0;
  for (const [x, y, z] of CORNERS(min, max)) {
    // Inward direction depends on whether this corner is the box min or max
    // along the axis (max corners extend toward the interior: corner - size).
    const segments: Array<[number, number, number]> = [
      [x === min.x ? x + bracket.x : x - bracket.x, y, z],
      [x, y === min.y ? y + bracket.y : y - bracket.y, z],
      [x, y, z === min.z ? z + bracket.z : z - bracket.z],
    ];
    for (const end of segments) {
      positions[offset++] = x;
      positions[offset++] = y;
      positions[offset++] = z;
      positions[offset++] = end[0];
      positions[offset++] = end[1];
      positions[offset++] = end[2];
    }
  }
  return positions;
}
