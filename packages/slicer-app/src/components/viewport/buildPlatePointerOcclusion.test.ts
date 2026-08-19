import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  BUILD_PLATE_RAYCAST,
  filterBuildPlateOccludedIntersections,
  MODEL_BODY_RAYCAST,
} from './buildPlatePointerOcclusion';

function object(role?: string): THREE.Object3D {
  const value = new THREE.Object3D();
  if (role) value.userData.orcaRaycastRole = role;
  return value;
}

describe('filterBuildPlateOccludedIntersections', () => {
  it('removes a model body reached only after the build plate', () => {
    const plate = { distance: 10, object: object(BUILD_PLATE_RAYCAST) };
    const hiddenBody = { distance: 12, object: object(MODEL_BODY_RAYCAST) };

    expect(filterBuildPlateOccludedIntersections([plate, hiddenBody])).toEqual([]);
  });

  it('keeps a model body in front of the build plate', () => {
    const body = { distance: 8, object: object(MODEL_BODY_RAYCAST) };
    const plate = { distance: 10, object: object(BUILD_PLATE_RAYCAST) };

    expect(filterBuildPlateOccludedIntersections([body, plate])).toEqual([body]);
  });

  it('keeps a model body when the plate is back-face culled from a below-bed view', () => {
    const body = { distance: 8, object: object(MODEL_BODY_RAYCAST) };

    expect(filterBuildPlateOccludedIntersections([body])).toEqual([body]);
  });

  it('never lets the plate occlude a gizmo hit', () => {
    const plate = { distance: 10, object: object(BUILD_PLATE_RAYCAST) };
    const gizmo = { distance: 12, object: object('gizmo') };

    expect(filterBuildPlateOccludedIntersections([plate, gizmo])).toEqual([gizmo]);
  });
});
