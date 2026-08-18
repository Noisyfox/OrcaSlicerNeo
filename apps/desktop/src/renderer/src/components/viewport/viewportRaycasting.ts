import type { PointerOwner } from './SceneInteractionController';

/**
 * R3F's event layer raycasts before it dispatches a pointer event. Keep that
 * work off while another control already owns the pointer gesture.
 */
export function isViewportRaycastingEnabled(
  cameraGestureActive: boolean,
  scenePointerOwner: PointerOwner,
): boolean {
  return !cameraGestureActive && scenePointerOwner === 'none';
}
