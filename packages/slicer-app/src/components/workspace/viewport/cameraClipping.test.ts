import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAMERA_FAR,
  DEFAULT_CAMERA_NEAR,
  deriveCameraClippingPlanes,
  expandCameraBoundsWithPlate,
} from './cameraClipping';

describe('camera clipping for the complete viewport scene', () => {
  it('keeps the normal single-plate range unchanged', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, DEFAULT_CAMERA_NEAR, DEFAULT_CAMERA_FAR);
    camera.position.set(110, -210, 320);
    camera.lookAt(110, 110, 0);
    const bounds = new THREE.Box3(
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(220, 220, 1),
    );

    expect(deriveCameraClippingPlanes(camera, bounds)).toEqual({
      near: DEFAULT_CAMERA_NEAR,
      far: DEFAULT_CAMERA_FAR,
    });
  });

  it('covers all 36 plate footprints without using an arbitrary huge far plane', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, DEFAULT_CAMERA_NEAR, DEFAULT_CAMERA_FAR);
    camera.position.set(660, -1000, 1400);
    camera.lookAt(660, 660, 0);
    const bounds = new THREE.Box3();
    const bed = { minX: 0, minY: 0, maxX: 220, maxY: 220 };
    for (let row = 0; row < 6; row += 1) {
      for (let column = 0; column < 6; column += 1) {
        expandCameraBoundsWithPlate(bounds, bed, [column * 240, row * 240, 0]);
      }
    }

    const planes = deriveCameraClippingPlanes(camera, bounds);
    expect(planes.far).toBeGreaterThan(DEFAULT_CAMERA_FAR);
    expect(planes.far).toBeLessThan(10_000);
    expect(planes.near).toBeGreaterThanOrEqual(0.05);
    expect(planes.far).toBeGreaterThan(camera.position.distanceTo(bounds.getCenter(new THREE.Vector3())));
  });

  it('keeps a scene that surrounds the camera valid without a negative near plane', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, DEFAULT_CAMERA_NEAR, DEFAULT_CAMERA_FAR);
    camera.position.set(0, 0, 0);
    camera.lookAt(0, 0, -1);
    const bounds = new THREE.Box3(
      new THREE.Vector3(-100, -100, -100),
      new THREE.Vector3(100, 100, 100),
    );

    const planes = deriveCameraClippingPlanes(camera, bounds);
    expect(planes.near).toBeGreaterThan(0);
    expect(planes.far).toBeGreaterThan(planes.near);
  });
});

