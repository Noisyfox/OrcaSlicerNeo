import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { RootState } from '@react-three/fiber';
import {
  BUILD_PLATE_RAYCAST,
  filterBuildPlateOccludedIntersections,
  MODEL_BODY_RAYCAST,
  pickTopmostModelVolume,
  topmostPrimeTowerHit,
} from './buildPlatePointerOcclusion';
import { GLVolume } from './GLVolume';

function object(role?: string): THREE.Object3D {
  const value = new THREE.Object3D();
  if (role) value.userData.orcaRaycastRole = role;
  return value;
}

describe('filterBuildPlateOccludedIntersections', () => {
  it('resolves a model volume from a mesh hit through its tagged parent group', () => {
    const volume = new GLVolume({
      objectIdx: 2, volumeIdx: 0, instanceIdx: 0,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      vertexCount: 3, indices: new Uint32Array([0, 1, 2]), indexCount: 3,
      offset: [0, 0, 0],
      instanceTransform: { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] },
      volumeTransform: { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] },
    });
    const sceneChildren: THREE.Object3D[] = [];
    const state = {
      gl: { domElement: { getBoundingClientRect: () => ({ width: 100, height: 100 }) } },
      raycaster: { setFromCamera: () => undefined, intersectObjects: () => [{ distance: 1, object: mesh }] },
      camera: {},
      scene: { children: sceneChildren },
    } as unknown as RootState;
    const group = new THREE.Group();
    group.userData.orcaRaycastRole = MODEL_BODY_RAYCAST;
    group.userData.orcaVolume = volume;
    const mesh = new THREE.Mesh();
    group.add(mesh);
    sceneChildren.push(group);
    expect(pickTopmostModelVolume(state, { x: 50, y: 50 })).toBe(volume);
    volume.dispose();
  });

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

  it('does not treat a tower behind a model as the context-menu target', () => {
    const tower = object();
    tower.userData.primeTower = true;
    const towerBand = object();
    tower.add(towerBand);
    const body = object(MODEL_BODY_RAYCAST);
    expect(topmostPrimeTowerHit([
      { distance: 8, object: body },
      { distance: 12, object: towerBand },
    ])).toBe(false);
    expect(topmostPrimeTowerHit([
      { distance: 8, object: towerBand },
      { distance: 12, object: body },
    ])).toBe(true);
  });

  it('keeps a nested model hit ahead of a tower in context-menu ordering', () => {
    const tower = object();
    tower.userData.primeTower = true;
    const towerBand = object();
    tower.add(towerBand);
    const modelGroup = object(MODEL_BODY_RAYCAST);
    const modelMesh = object();
    modelGroup.add(modelMesh);
    expect(topmostPrimeTowerHit([
      { distance: 8, object: modelMesh },
      { distance: 12, object: towerBand },
    ])).toBe(false);
  });

  it('recognizes a non-current tower through its nested band mesh', () => {
    const tower = object();
    tower.userData.primeTower = true;
    tower.userData.plateId = 'plate-2';
    const towerBand = object();
    tower.add(towerBand);
    expect(topmostPrimeTowerHit([{ distance: 4, object: towerBand }])).toBe(true);
  });
});
