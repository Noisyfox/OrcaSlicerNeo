import * as THREE from 'three';
import type { RootState } from '@react-three/fiber';
import { GLVolume } from './GLVolume';

export const BUILD_PLATE_RAYCAST = 'build-plate-raycast';
export const MODEL_BODY_RAYCAST = 'model-body-raycast';

type RaycastObject = Pick<THREE.Object3D, 'userData'>;
type RaycastIntersection = Pick<THREE.Intersection, 'distance' | 'object'>;

function hasRaycastRole(object: RaycastObject, role: string): boolean {
  return object.userData.orcaRaycastRole === role;
}

function hasRaycastRoleInParents(object: THREE.Object3D, role: string): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (hasRaycastRole(current, role)) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Keeps model-body hits only when they occur in front of the build plate.
 * The plate is deliberately removed from the returned list: it participates
 * in raycasting as an occluder, while an otherwise empty bed press remains a
 * pointer miss and clears selection through the existing canvas handler.
 */
export function filterBuildPlateOccludedIntersections<T extends RaycastIntersection>(
  intersections: T[],
): T[] {
  const plateDistance = intersections.reduce<number | null>((nearest, hit) => {
    if (!hasRaycastRoleInParents(hit.object as THREE.Object3D, BUILD_PLATE_RAYCAST)) return nearest;
    return nearest === null ? hit.distance : Math.min(nearest, hit.distance);
  }, null);

  return intersections.filter((hit) => {
    if (hasRaycastRoleInParents(hit.object as THREE.Object3D, BUILD_PLATE_RAYCAST)) return false;
    return plateDistance === null
      || !hasRaycastRoleInParents(hit.object as THREE.Object3D, MODEL_BODY_RAYCAST)
      || hit.distance <= plateDistance;
  });
}

/** Whether the topmost visible scene target is the current prime tower. */
export function topmostCurrentPrimeTowerHit<T extends RaycastIntersection>(intersections: T[]): boolean {
  const visible = filterBuildPlateOccludedIntersections(intersections);
  const target = visible.find((hit) => {
    if (hasRaycastRoleInParents(hit.object as THREE.Object3D, MODEL_BODY_RAYCAST)) return true;
    let current: THREE.Object3D | null = hit.object as THREE.Object3D;
    while (current) {
      if (current.userData.primeTower === true && current.userData.plateCurrent === true) return true;
      current = current.parent;
    }
    return false;
  });
  if (!target) return false;
  if (hasRaycastRole(target.object, MODEL_BODY_RAYCAST)) return false;
  let current: THREE.Object3D | null = target.object as THREE.Object3D;
  while (current) {
    if (current.userData.primeTower === true && current.userData.plateCurrent === true) return true;
    current = current.parent;
  }
  return false;
}

/** The topmost visible model body under a viewport-CSS point, or null. */
export function pickTopmostModelVolume(
  state: RootState | null,
  point: { x: number; y: number },
): GLVolume | null {
  if (!state) return null;
  const rect = state.gl.domElement.getBoundingClientRect();
  const nx = (point.x / rect.width) * 2 - 1;
  const ny = -((point.y / rect.height) * 2) + 1;
  if (nx < -1 || nx > 1 || ny < -1 || ny > 1) return null;
  state.raycaster.setFromCamera(new THREE.Vector2(nx, ny), state.camera);
  const hits = filterBuildPlateOccludedIntersections(
    state.raycaster.intersectObjects(state.scene.children, true),
  );
  const hit = hits.find((candidate) => hasRaycastRoleInParents(candidate.object as THREE.Object3D, MODEL_BODY_RAYCAST));
  if (!hit) return null;
  let current: THREE.Object3D | null = hit.object as THREE.Object3D;
  while (current) {
    const volume = current.userData.orcaVolume;
    if (volume instanceof GLVolume) return volume;
    current = current.parent;
  }
  return null;
}

/** Return the bed identity under a viewport-relative CSS point. */
export function pickBuildPlateId(
  state: RootState | null,
  point: { x: number; y: number },
): string | null {
  if (!state) return null;
  const rect = state.gl.domElement.getBoundingClientRect();
  const nx = (point.x / rect.width) * 2 - 1;
  const ny = -((point.y / rect.height) * 2) + 1;
  if (nx < -1 || nx > 1 || ny < -1 || ny > 1) return null;
  state.raycaster.setFromCamera(new THREE.Vector2(nx, ny), state.camera);
  const hit = state.raycaster.intersectObjects(state.scene.children, true).find(
    (candidate) => hasRaycastRole(candidate.object, BUILD_PLATE_RAYCAST),
  );
  const plateId = hit?.object.userData.plateId;
  return typeof plateId === 'string' ? plateId : null;
}
