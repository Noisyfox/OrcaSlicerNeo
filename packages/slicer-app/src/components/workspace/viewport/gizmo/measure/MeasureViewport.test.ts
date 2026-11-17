import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { MeasurePlane, ModelObjectBuffer } from '@slicer/client';
import { GLVolume } from '../../GLVolume';
import { MeasurePlaneResources } from './MeasurePlaneResources';
import { MeasureSurfacePicker } from './MeasureSurfacePicker';
import { measurePixelScale } from './MeasureViewport';

describe('Measure viewport resources', () => {
  it('uses the copied native plane for transformed picking, reuses it, and disposes it on removal', () => {
    const matrix = new THREE.Matrix4().makeTranslation(2, 4, 3).toArray();
    const plane: MeasurePlane = { ok: true, version: 1, sessionId: 'ms-1', targetRevision: 1,
      displayId: 'md-1', resourceId: 'mp-1', transform: matrix,
      vertices: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0]) };
    const resources = new MeasurePlaneResources(); const planes = new Map([[plane.resourceId, plane]]);
    resources.sync(planes); const first = resources.get('mp-1')!;
    const ray = new THREE.Raycaster(new THREE.Vector3(2, 4, 10), new THREE.Vector3(0, 0, -1));
    expect(ray.intersectObject(first.pick)[0]?.point.toArray()).toEqual([2, 4, 3]);
    resources.sync(new Map(planes)); expect(resources.get('mp-1')).toBe(first);
    const dispose = vi.spyOn(first.geometry, 'dispose');
    resources.sync(new Map()); expect(dispose).toHaveBeenCalledOnce(); expect(resources.get('mp-1')).toBeUndefined();
    resources.dispose();
  });

  it('keeps markers the same CSS size under perspective and orthographic projection', () => {
    const perspective = new THREE.PerspectiveCamera(90, 1, .1, 100);
    perspective.position.set(0, 0, 10); perspective.lookAt(0, 0, 0); perspective.updateMatrixWorld();
    expect(measurePixelScale(perspective, 200, [0, 0, 0])).toBeCloseTo(.1);
    expect(measurePixelScale(perspective, 200, [0, 0, -10])).toBeCloseTo(.2);
    const ortho = new THREE.OrthographicCamera(-2, 2, 2, -2, .1, 100);
    ortho.position.set(0, 0, 10); ortho.lookAt(0, 0, 0); ortho.updateMatrixWorld();
    expect(measurePixelScale(ortho, 200, [0, 0, 0])).toBeCloseTo(.02);
    expect(measurePixelScale(ortho, 200, [0, 0, -10])).toBeCloseTo(.02);
  });

  it('preflights the selected original mesh from both sides using live transforms', () => {
    const transform = { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] } as const;
    const buffer: ModelObjectBuffer = { objectId: 1, instanceId: 2, volumeId: 3, objectIdx: 0, instanceIdx: 0, volumeIdx: 0,
      positions: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), vertexCount: 3,
      indices: new Uint32Array([0, 1, 2]), indexCount: 3, offset: [0, 0, 0],
      instanceTransform: { offset: [...transform.offset], rotation: [...transform.rotation], scale: [...transform.scale], mirror: [...transform.mirror] },
      volumeTransform: { offset: [...transform.offset], rotation: [...transform.rotation], scale: [...transform.scale], mirror: [...transform.mirror] } };
    const volume = new GLVolume(buffer, { kind: 'exclusive' });
    const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, .1, 100);
    camera.position.set(0, 0, -10); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    const rect = { left: 0, top: 0, width: 100, height: 100 } as DOMRect;
    const picker = new MeasureSurfacePicker();
    expect(picker.hits({ clientX: 50, clientY: 50 }, rect, camera, [volume], [])).toBe(true);
    volume.instanceTransform = { ...volume.instanceTransform, offset: [3, 0, 0] };
    expect(picker.hits({ clientX: 50, clientY: 50 }, rect, camera, [volume], [])).toBe(false);
    picker.dispose(); volume.dispose();
  });
});
