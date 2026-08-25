// Pure transform math for the rotate/scale gizmos and their sidebar panels.
// The data model is OrcaSlicer's T·R·S instance/volume transform:
//   T(offset) · R(rotation) · S(scale ⊙ mirror)
// with the C++ slicer composing R as Rz(z)·Ry(y)·Rx(x) (Geometry::assemble_transform).
// three.js Euler order 'ZYX' produces exactly that matrix, so every place the
// renderer consumes `rotation` must use this order — see the 2026-08-21
// rotate/scale design doc.
import * as THREE from 'three';
import type { ModelTransform } from '@slicer/client';
import type { Vec3 } from '../../../lib/vec3';

export type Matrix4Tuple = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

/** Must match C++ assemble_transform (Rz·Ry·Rx). */
export const EULER_ORDER: THREE.EulerOrder = 'ZYX';
/** Scale factors are clamped to this positive floor (mirror is the flip tool). */
export const MIN_SCALE = 1e-3;

/** The instance's affine matrix — `.matrix` when present (shear), else T·R·S. */
export function matrixFromTransform(transform: ModelTransform): THREE.Matrix4 {
  if (transform.matrix) return new THREE.Matrix4().fromArray(transform.matrix);
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...transform.offset),
    quatFromRotation(transform.rotation),
    new THREE.Vector3(
      transform.scale[0] * transform.mirror[0],
      transform.scale[1] * transform.mirror[1],
      transform.scale[2] * transform.mirror[2],
    ),
  );
}

/** True when the linear part is not rotation×diagonal-scale (i.e. has shear). */
export function hasShear(matrix: THREE.Matrix4): boolean {
  const e = matrix.elements;
  const columns = [
    new THREE.Vector3(e[0], e[1], e[2]),
    new THREE.Vector3(e[4], e[5], e[6]),
    new THREE.Vector3(e[8], e[9], e[10]),
  ];
  const tolerance = 1e-4;
  const orthogonal = (a: THREE.Vector3, b: THREE.Vector3) =>
    Math.abs(a.dot(b)) / (a.length() * b.length() + 1e-12) < tolerance;
  return !(orthogonal(columns[0], columns[1]) && orthogonal(columns[0], columns[2]) && orthogonal(columns[1], columns[2]));
}

/** Nearest rotation (rotation polar factor) via Higham's iteration. */
function polarRotation(linear: THREE.Matrix3): THREE.Matrix3 {
  let current = linear.clone();
  for (let i = 0; i < 30; i++) {
    const inv = current.clone().invert();
    inv.transpose();
    const e = current.elements;
    const ie = inv.elements;
    for (let k = 0; k < 9; k++) e[k] = 0.5 * (e[k] + ie[k]);
  }
  return current;
}

/**
 * Build a ModelTransform from an affine matrix. When it is a clean
 * rotation×diagonal-scale, store TRS (no `matrix`); otherwise store the matrix
 * verbatim (authoritative) plus the closest TRS decomposition for display.
 */
export function transformFromMatrix(matrix: THREE.Matrix4, source: ModelTransform): ModelTransform {
  const offset = [matrix.elements[12], matrix.elements[13], matrix.elements[14]] as Vec3;
  if (!hasShear(matrix)) {
    const linear = new THREE.Matrix3().setFromMatrix4(matrix);
    const cols = [0, 3, 6].map((i) => new THREE.Vector3(linear.elements[i], linear.elements[i + 1], linear.elements[i + 2]));
    const scale = cols.map((c) => c.length()) as Vec3;
    const units = cols.map((c) => c.clone().normalize());
    const mirror = [1, 1, 1] as Vec3;
    const rotation = new THREE.Matrix3().set(
      units[0].x, units[1].x, units[2].x,
      units[0].y, units[1].y, units[2].y,
      units[0].z, units[1].z, units[2].z,
    );
    if (rotation.determinant() < 0) {
      const idx = scale.indexOf(Math.min(...scale));
      units[idx].negate();
      mirror[idx] = -1;
      rotation.set(
        units[0].x, units[1].x, units[2].x,
        units[0].y, units[1].y, units[2].y,
        units[0].z, units[1].z, units[2].z,
      );
    }
    const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().setFromMatrix3(rotation));
    return {
      offset,
      rotation: rotationFromQuat(quat),
      scale: scale.map((s) => Math.abs(s)) as Vec3,
      mirror,
    };
  }
  const linear = new THREE.Matrix3().setFromMatrix4(matrix);
  const rotation = polarRotation(linear);
  const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().setFromMatrix3(rotation));
  const scale = [
    new THREE.Vector3(linear.elements[0], linear.elements[1], linear.elements[2]).length(),
    new THREE.Vector3(linear.elements[3], linear.elements[4], linear.elements[5]).length(),
    new THREE.Vector3(linear.elements[6], linear.elements[7], linear.elements[8]).length(),
  ] as Vec3;
  return {
    offset,
    rotation: rotationFromQuat(quat),
    scale,
    mirror: [1, 1, 1],
    matrix: matrix.elements.slice() as Matrix4Tuple,
  };
}

/** Drop a redundant `matrix` when a transform has no shear (keeps TRS). */
export function normalizeTransform(transform: ModelTransform): ModelTransform {
  if (!transform.matrix) return transform;
  if (hasShear(new THREE.Matrix4().fromArray(transform.matrix))) return transform;
  return {
    offset: [...transform.offset] as Vec3,
    rotation: [...transform.rotation] as Vec3,
    scale: [...transform.scale] as Vec3,
    mirror: [...transform.mirror] as Vec3,
  };
}

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
  if (transform.matrix) {
    const m = matrixFromTransform(transform);
    const r = new THREE.Matrix4().makeRotationFromQuaternion(deltaQuat);
    const result = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z)
      .multiply(r)
      .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z))
      .multiply(m);
    return transformFromMatrix(result, transform);
  }
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
  // Scale along the axes of `spaceQuat` (identity = world, the selection
  // orientation = local). The linear result may shear — e.g. a non-uniform
  // world scale of an arbitrarily-rotated object — which T·R·S cannot store,
  // so it falls back to the full affine `matrix`. For clean transforms this
  // reproduces the classic T·R·S scale exactly.
  const safeFactor = factor.map((f) => clampScale(f)) as Vec3;
  const spaceScale = new THREE.Matrix4()
    .compose(new THREE.Vector3(), spaceQuat.clone().normalize(), new THREE.Vector3(...safeFactor))
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(spaceQuat.clone().invert()));
  const result = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(spaceScale)
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z))
    .multiply(matrixFromTransform(transform));
  const out = transformFromMatrix(result, transform);
  return { ...out, scale: out.scale.map((s) => clampScale(Math.abs(s))) as Vec3 };
}

// Matrix-level delta helpers. These operate on a world matrix directly so a
// part-scoped (volume) edit can compose a world-space delta with the volume's
// world matrix (instance·volume) and then solve the volume back out — the
// instance transform is left untouched (only the selected parts move).

export function translateMatrix(matrix: THREE.Matrix4, delta: THREE.Vector3): THREE.Matrix4 {
  const out = matrix.clone();
  out.elements[12] += delta.x;
  out.elements[13] += delta.y;
  out.elements[14] += delta.z;
  return out;
}

export function rotateMatrixAroundPivot(matrix: THREE.Matrix4, deltaQuat: THREE.Quaternion, pivot: THREE.Vector3): THREE.Matrix4 {
  return new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(deltaQuat))
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z))
    .multiply(matrix);
}

export function scaleMatrixAroundPivot(matrix: THREE.Matrix4, factor: Vec3, pivot: THREE.Vector3, spaceQuat: THREE.Quaternion): THREE.Matrix4 {
  const safeFactor = factor.map((f) => clampScale(f)) as Vec3;
  const spaceScale = new THREE.Matrix4()
    .compose(new THREE.Vector3(), spaceQuat.clone().normalize(), new THREE.Vector3(...safeFactor))
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(spaceQuat.clone().invert()));
  return new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(spaceScale)
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z))
    .multiply(matrix);
}

function cloneTransform(transform: ModelTransform): ModelTransform {
  return {
    offset: [...transform.offset] as Vec3,
    rotation: [...transform.rotation] as Vec3,
    scale: [...transform.scale] as Vec3,
    mirror: [...transform.mirror] as Vec3,
  };
}
