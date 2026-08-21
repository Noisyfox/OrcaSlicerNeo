import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { ModelTransform } from '@slicer/client';
import type { Vec3 } from '../../lib/vec3';
import {
  EULER_ORDER,
  MIN_SCALE,
  quatFromRotation,
  rotationFromQuat,
  clampScale,
  applyRotationDelta,
  applyScaleDelta,
} from './transformDeltaMath';

function makeTransform(partial?: Partial<ModelTransform>): ModelTransform {
  return {
    offset: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    mirror: [1, 1, 1],
    ...partial,
  };
}

describe('Euler ZYX convention', () => {
  it('matches the C++ Rz(z)·Ry(y)·Rx(x) composition', () => {
    // Reference matrix built exactly like Geometry::assemble_transform.
    const r = (a: number, b: number, c: number) => {
      const x = new THREE.Matrix4().makeRotationX(a);
      const y = new THREE.Matrix4().makeRotationY(b);
      const z = new THREE.Matrix4().makeRotationZ(c);
      return z.multiply(y).multiply(x);
    };
    const angles: Vec3 = [0.7, -0.4, 1.2];
    const fromThree = new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(...angles, EULER_ORDER),
    );
    expect(fromThree.elements).toEqual(r(...angles).elements);
  });

  it('round-trips a quaternion through the ZYX euler angles', () => {
    const rotation: Vec3 = [0.7, -0.4, 1.2];
    const roundTripped = rotationFromQuat(quatFromRotation(rotation));
    expect(roundTripped[0]).toBeCloseTo(rotation[0], 10);
    expect(roundTripped[1]).toBeCloseTo(rotation[1], 10);
    expect(roundTripped[2]).toBeCloseTo(rotation[2], 10);
  });
});

describe('clampScale', () => {
  it('keeps values above the floor and clamps below', () => {
    expect(clampScale(2)).toBe(2);
    expect(clampScale(MIN_SCALE)).toBe(MIN_SCALE);
    expect(clampScale(0)).toBe(MIN_SCALE);
    expect(clampScale(-3)).toBe(MIN_SCALE);
  });
});

describe('applyRotationDelta', () => {
  it('orbits the offset around the pivot and recomposes the rotation', () => {
    const transform = makeTransform({ offset: [10, 0, 0], rotation: [0, 0, 0] });
    const pivot = new THREE.Vector3(0, 0, 0);
    const quarter = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const next = applyRotationDelta(transform, quarter, pivot);
    expect(next.offset[0]).toBeCloseTo(0, 8);
    expect(next.offset[1]).toBeCloseTo(10, 8);
    expect(next.offset[2]).toBeCloseTo(0, 8);
    expect(next.rotation[2]).toBeCloseTo(Math.PI / 2, 8);
  });

  it('keeps scale and mirror untouched', () => {
    const transform = makeTransform({ scale: [2, 3, 4], mirror: [-1, 1, 1] });
    const next = applyRotationDelta(transform, new THREE.Quaternion(), new THREE.Vector3(1, 2, 3));
    expect(next.scale).toEqual([2, 3, 4]);
    expect(next.mirror).toEqual([-1, 1, 1]);
  });

  it('rotates a pre-rotated instance by the world delta', () => {
    const transform = makeTransform({ rotation: [0, Math.PI / 2, 0] });
    const quarter = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const next = applyRotationDelta(transform, quarter, new THREE.Vector3());
    const world = new THREE.Quaternion().multiplyQuaternions(
      quarter,
      quatFromRotation(transform.rotation),
    );
    const actual = quatFromRotation(next.rotation);
    expect(actual.x).toBeCloseTo(world.x, 10);
    expect(actual.y).toBeCloseTo(world.y, 10);
    expect(actual.z).toBeCloseTo(world.z, 10);
    expect(actual.w).toBeCloseTo(world.w, 10);
  });
});

describe('applyScaleDelta', () => {
  it('scales around the pivot in world space when the space quat is identity', () => {
    const transform = makeTransform({ offset: [10, 4, 0], scale: [1, 1, 1] });
    const pivot = new THREE.Vector3(0, 0, 0);
    const next = applyScaleDelta(transform, [2, 0.5, 1], pivot, new THREE.Quaternion());
    expect(next.offset[0]).toBeCloseTo(20, 8);
    expect(next.offset[1]).toBeCloseTo(2, 8);
    expect(next.scale).toEqual([2, 0.5, 1]);
  });

  it('scales along the object axes in local space', () => {
    // Object rotated 90° about Z: its local X is world Y. An offset on the
    // object's local-X line (world Y) must move along that line.
    const rotation: Vec3 = [0, 0, Math.PI / 2];
    const transform = makeTransform({ offset: [0, 10, 0], rotation });
    const pivot = new THREE.Vector3(0, 0, 0);
    const space = quatFromRotation(rotation);
    const next = applyScaleDelta(transform, [2, 1, 1], pivot, space);
    expect(next.offset[0]).toBeCloseTo(0, 8);
    expect(next.offset[1]).toBeCloseTo(20, 8);
    expect(next.scale).toEqual([2, 1, 1]);
  });

  it('applies a world-axis factor to the correct local axis when rotated', () => {
    // Cube rotated 90° about Z: its local Y is world X, so a world-X ×2 must
    // multiply the LOCAL Y scale (world-X width is otherwise untouched).
    const rotation: Vec3 = [0, 0, Math.PI / 2];
    const transform = makeTransform({ offset: [0, 0, 0], rotation, scale: [1, 1, 1] });
    const pivot = new THREE.Vector3(0, 0, 0);
    const next = applyScaleDelta(transform, [2, 1, 1], pivot, new THREE.Quaternion());
    expect(next.scale).toEqual([1, 2, 1]);
    // An unrotated object keeps the plain local factor (regression guard).
    expect(applyScaleDelta(makeTransform({ scale: [1, 1, 1] }), [2, 1, 1], new THREE.Vector3(), new THREE.Quaternion()).scale)
      .toEqual([2, 1, 1]);
  });

  it('clamps scale factors to the positive floor', () => {
    const transform = makeTransform({ scale: [1, 1, 1] });
    const next = applyScaleDelta(transform, [-2, 0, 1], new THREE.Vector3(), new THREE.Quaternion());
    expect(next.scale[0]).toBe(MIN_SCALE);
    expect(next.scale[1]).toBe(MIN_SCALE);
    expect(next.scale[2]).toBe(1);
  });
});
