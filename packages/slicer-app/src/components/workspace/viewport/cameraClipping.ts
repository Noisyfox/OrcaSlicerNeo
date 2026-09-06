import * as THREE from 'three';

/** The default Three.js perspective range used by the original single-bed view. */
export const DEFAULT_CAMERA_NEAR = 0.1;
export const DEFAULT_CAMERA_FAR = 2000;

const MIN_CAMERA_NEAR = 0.05;
const MAX_CAMERA_NEAR = 10;
const FAR_MARGIN_MM = 20;
const FAR_MARGIN_RATIO = 0.05;

export interface CameraClippingPlanes {
  near: number;
  far: number;
}

/**
 * Derive a perspective camera range that contains every point in an AABB.
 *
 * The far plane follows the current camera direction, so a 36-plate grid is
 * covered when the user zooms out without imposing a large fixed far plane on
 * normal single-plate views. For a genuinely large scene the near plane is
 * raised conservatively from the closest scene point to retain depth
 * precision; it is never raised when the default range is sufficient.
 */
export function deriveCameraClippingPlanes(
  camera: THREE.PerspectiveCamera,
  sceneBounds: THREE.Box3,
): CameraClippingPlanes {
  if (sceneBounds.isEmpty()) {
    return { near: DEFAULT_CAMERA_NEAR, far: DEFAULT_CAMERA_FAR };
  }

  const direction = camera.getWorldDirection(new THREE.Vector3());
  const center = sceneBounds.getCenter(new THREE.Vector3());
  const halfSize = sceneBounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  // The support radius of an AABB along any unit direction is exact for the
  // farthest/nearest point along that direction and avoids allocating eight
  // corner vectors on every demand-rendered frame.
  const centerDepth = center.sub(camera.position).dot(direction);
  const supportDepth = Math.abs(direction.x) * halfSize.x
    + Math.abs(direction.y) * halfSize.y
    + Math.abs(direction.z) * halfSize.z;
  const nearestDepth = centerDepth - supportDepth;
  const farthestDepth = centerDepth + supportDepth;

  // A camera inside or behind the scene still needs a valid positive range.
  // In ordinary viewport use farthestDepth is positive; this fallback keeps
  // the calculation total for test hooks and unusual orbit positions.
  const requiredFar = Math.max(
    DEFAULT_CAMERA_FAR,
    Math.max(1, farthestDepth) * (1 + FAR_MARGIN_RATIO) + FAR_MARGIN_MM,
  );
  if (requiredFar <= DEFAULT_CAMERA_FAR) {
    return { near: DEFAULT_CAMERA_NEAR, far: DEFAULT_CAMERA_FAR };
  }

  const near = Number.isFinite(nearestDepth) && nearestDepth > 0
    ? THREE.MathUtils.clamp(nearestDepth * 0.01, MIN_CAMERA_NEAR, MAX_CAMERA_NEAR)
    : MIN_CAMERA_NEAR;
  return {
    near: Math.min(near, requiredFar * 0.25),
    far: requiredFar,
  };
}

/** Expand an AABB with a bed footprint translated by a plate origin. */
export function expandCameraBoundsWithPlate(
  target: THREE.Box3,
  bedBounds: { minX: number; minY: number; maxX: number; maxY: number },
  origin: readonly [number, number, number],
): THREE.Box3 {
  target.expandByPoint(new THREE.Vector3(
    origin[0] + bedBounds.minX,
    origin[1] + bedBounds.minY,
    origin[2] - 1,
  ));
  target.expandByPoint(new THREE.Vector3(
    origin[0] + bedBounds.maxX,
    origin[1] + bedBounds.maxY,
    origin[2] + 1,
  ));
  return target;
}

