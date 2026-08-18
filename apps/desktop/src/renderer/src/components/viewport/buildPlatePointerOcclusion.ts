import type * as THREE from 'three';

export const BUILD_PLATE_RAYCAST = 'build-plate-raycast';
export const MODEL_BODY_RAYCAST = 'model-body-raycast';

type RaycastObject = Pick<THREE.Object3D, 'userData'>;
type RaycastIntersection = Pick<THREE.Intersection, 'distance' | 'object'>;

function hasRaycastRole(object: RaycastObject, role: string): boolean {
  return object.userData.orcaRaycastRole === role;
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
    if (!hasRaycastRole(hit.object, BUILD_PLATE_RAYCAST)) return nearest;
    return nearest === null ? hit.distance : Math.min(nearest, hit.distance);
  }, null);

  return intersections.filter((hit) => {
    if (hasRaycastRole(hit.object, BUILD_PLATE_RAYCAST)) return false;
    return plateDistance === null
      || !hasRaycastRole(hit.object, MODEL_BODY_RAYCAST)
      || hit.distance <= plateDistance;
  });
}
