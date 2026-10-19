// The aggregate-selection bounding box, rendered like OrcaSlicer's native
// selection box (Selection::render_bounding_box): one white bracket box around
// the union of every selected volume, solid lines, depth-tested against the
// model. See spec/Viewport Interaction.md.
import { useLayoutEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { useSceneInteraction, useSceneInteractionVersion } from './SceneInteractionContext';
import { SelectionBoundsBoxProbe } from '@/e2e/SelectionBoundsBoxProbe';

declare const __ORCA_E2E__: boolean;

const SELECTION_BOX_COLOR = 0xffffff;
const BRACKET_SEGMENT_VERTEX_COUNT = 48;

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

export function SelectionBoundsBox() {
  const sceneInteraction = useSceneInteraction();
  useSceneInteractionVersion();
  const invalidate = useThree((s) => s.invalidate);

  const bounds = sceneInteraction.selectionBounds();
  // The box renders only while no gizmo is opened — an armed gizmo takes over
  // the selection visual. Body drags keep it visible and following.
  const gizmoOpen = sceneInteraction.gizmo !== null;
  const positions = bounds && !gizmoOpen ? selectionBoundsBoxPositions(bounds) : null;

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(new Float32Array(BRACKET_SEGMENT_VERTEX_COUNT * 3), 3),
    );
    return geo;
  }, []);

  // Mutate the persistent geometry on every selection/transform change (the
  // context version bumps on each controller emit), like ToolpathLines.
  useLayoutEffect(() => {
    if (!positions) return;
    const attribute = geometry.getAttribute('position') as THREE.BufferAttribute;
    (attribute.array as Float32Array).set(positions);
    attribute.needsUpdate = true;
    geometry.computeBoundingSphere();
    invalidate();
  }, [geometry, invalidate, positions]);

  return (
    <>
      {positions && (
        <lineSegments
          geometry={geometry}
          frustumCulled={false}
          // The box is a visual overlay, never a pick target (context menu and
          // Shift+click fallbacks raycast the raw scene children).
          raycast={() => undefined}
        >
          <lineBasicMaterial color={SELECTION_BOX_COLOR} />
        </lineSegments>
      )}
      {__ORCA_E2E__ && <SelectionBoundsBoxProbe bounds={bounds} positions={positions} />}
    </>
  );
}
