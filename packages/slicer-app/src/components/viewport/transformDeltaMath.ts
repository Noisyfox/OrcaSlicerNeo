// Pure transform math for the rotate/scale gizmos and their sidebar panels.
// The data model is OrcaSlicer's T·R·S instance/volume transform:
//   T(offset) · R(rotation) · S(scale ⊙ mirror)
// with the C++ slicer composing R as Rz(z)·Ry(y)·Rx(x) (Geometry::assemble_transform).
// three.js Euler order 'ZYX' produces exactly that matrix, so every place the
// renderer consumes `rotation` must use this order — see the 2026-08-21
// rotate/scale design doc.
import * as THREE from 'three';
import type { ModelTransform } from '@slicer/client';
import type { Vec3 } from '../../lib/vec3';

/** Must match C++ assemble_transform (Rz·Ry·Rx). */
export const EULER_ORDER: THREE.EulerOrder = 'ZYX';
/** Scale factors are clamped to this positive floor (mirror is the flip tool). */
export const MIN_SCALE = 1e-3;

export function quatFromRotation(rotation: Vec3): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(rotation[0], rotation[1], rotation[2], EULER_ORDER),
  );
}

export function rotationFromQuat(quaternion: THREE.Quaternion): Vec3 {
  const euler = new THREE.Euler().setFromQuaternion(quaternion, EULER_ORDER);
  return [euler.x, euler.y, euler.z];
}

/** Clamp a scale factor/value to the positive floor. */
export function clampScale(value: number): number {
  return value > MIN_SCALE ? value : MIN_SCALE;
}

/**
 * Rotate an instance rigidly around `pivot`: the offset orbits the pivot and
 * the rotation is recomposed as `deltaQuat · quatZYX(rotation)` (world
 * pre-multiplication, exactly what TransformControls writes in world mode).
 */
export function applyRotationDelta(
  transform: ModelTransform,
  deltaQuat: THREE.Quaternion,
  pivot: THREE.Vector3,
): ModelTransform {
  const offset = new THREE.Vector3(...transform.offset).sub(pivot);
  offset.applyQuaternion(deltaQuat).add(pivot);
  const rotation = rotationFromQuat(
    new THREE.Quaternion().multiplyQuaternions(deltaQuat, quatFromRotation(transform.rotation)),
  );
  return { ...cloneTransform(transform), offset: [offset.x, offset.y, offset.z], rotation };
}

/**
 * Scale an instance around `pivot` by `factor` along the axes of `spaceQuat`
 * (identity = world axes, the selection orientation = local axes). The factor
 * multiplies `scale` componentwise — scale factors live in the object's local
 * frame in the T·R·S data model, so the rendered view equals the sliced one.
 */
export function applyScaleDelta(
  transform: ModelTransform,
  factor: Vec3,
  pivot: THREE.Vector3,
  spaceQuat: THREE.Quaternion,
): ModelTransform {
  const offset = new THREE.Vector3(...transform.offset).sub(pivot);
  offset.applyQuaternion(spaceQuat.clone().invert());
  offset.x *= factor[0];
  offset.y *= factor[1];
  offset.z *= factor[2];
  offset.applyQuaternion(spaceQuat).add(pivot);
  // The data model applies scale in the object's LOCAL (post-rotation) frame
  // (T·R·S). A WORLD-axis factor on a rotated object must first be converted
  // into local factors, otherwise — e.g. a cube rotated 90° about Z — a
  // world-X drag leaves the world-X width unchanged and scales the world-Y
  // width instead. f_eff is the diagonal of the world scale operator
  // expressed in the instance's local frame:
  //   M = R⁻¹ · spaceQuat · diag(factor) · spaceQuat⁻¹ · R
  // which is exact when the rotation axis aligns with a scaling axis (the
  // common 90°/180° case). Non-uniform world scale of an arbitrarily-rotated
  // object is not representable as T·R·S (it would shear); the diagonal is
  // the closest representation.
  const q = quatFromRotation(transform.rotation);
  const m = new THREE.Matrix4()
    .makeRotationFromQuaternion(q.clone().invert())
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(spaceQuat))
    .multiply(new THREE.Matrix4().makeScale(factor[0], factor[1], factor[2]))
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(spaceQuat.clone().invert()))
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(q));
  const localFactor: [number, number, number] = [m.elements[0], m.elements[5], m.elements[10]];
  return {
    ...cloneTransform(transform),
    offset: [offset.x, offset.y, offset.z],
    scale: [
      clampScale(transform.scale[0] * localFactor[0]),
      clampScale(transform.scale[1] * localFactor[1]),
      clampScale(transform.scale[2] * localFactor[2]),
    ],
  };
}

function cloneTransform(transform: ModelTransform): ModelTransform {
  return {
    offset: [...transform.offset] as Vec3,
    rotation: [...transform.rotation] as Vec3,
    scale: [...transform.scale] as Vec3,
    mirror: [...transform.mirror] as Vec3,
  };
}
