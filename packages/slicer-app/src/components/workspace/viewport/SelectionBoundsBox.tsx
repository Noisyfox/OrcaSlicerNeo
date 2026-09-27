// The aggregate-selection bounding box, rendered like OrcaSlicer's native
// selection box (Selection::render_bounding_box): one white bracket box around
// the union of every selected volume, solid lines, depth-tested against the
// model. See doc/2026-08-22-viewport-selection-box.md.
import { useLayoutEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { useSceneInteraction, useSceneInteractionVersion } from './SceneInteractionContext';
import { selectionBoundsBoxPositions } from './selectionBoundsBoxGeometry';
import { SelectionBoundsBoxProbe } from '../../../e2e/SelectionBoundsBoxProbe';

declare const __ORCA_E2E__: boolean;

const SELECTION_BOX_COLOR = 0xffffff;
const BRACKET_SEGMENT_VERTEX_COUNT = 48;

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
