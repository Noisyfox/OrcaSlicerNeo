import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { ModelObjectBuffer } from '@slicer/client';
import { GLVolume } from './GLVolume';
import { SceneInteractionController } from './SceneInteractionController';

function makeVolume(objectIdx: number, volumeIdx: number, instanceIdx: number, offset: [number, number, number]): GLVolume {
  const buffer: ModelObjectBuffer = {
    objectIdx,
    volumeIdx,
    instanceIdx,
    positions: new Float32Array([
      -1, -1, -2,
      1, 1, 2,
      1, -1, -2,
    ]),
    vertexCount: 3,
    indices: new Uint32Array([0, 1, 2]),
    indexCount: 3,
    offset,
    instanceTransform: { offset: [...offset], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] },
    volumeTransform: { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] },
  };
  return new GLVolume(buffer);
}

describe('SceneInteractionController', () => {
  let volumes: GLVolume[];
  let controller: SceneInteractionController;

  beforeEach(() => {
    volumes = [
      makeVolume(0, 0, 0, [0, 0, 0]),
      makeVolume(0, 1, 0, [0, 0, 0]),
      makeVolume(0, 0, 1, [20, 5, 0]),
      makeVolume(0, 1, 1, [20, 5, 0]),
    ];
    controller = new SceneInteractionController(() => volumes);
  });

  it('keeps one move gizmo open for a non-empty selection and closes it when cleared', () => {
    controller.selectFromHit(volumes[0], false);
    expect(controller.gizmo).toBe('move');
    expect(controller.selectedVolumes()).toEqual([volumes[0], volumes[1]]);

    controller.clearSelection();
    expect(controller.gizmo).toBeNull();
    expect(controller.owner).toBe('none');
  });

  it('moves every selected instance by an equal gesture delta and preserves spacing', () => {
    controller.selectFromHit(volumes[0], false);
    controller.selectFromHit(volumes[2], true);
    const pivot = controller.selectionPivot()!;

    expect(controller.beginGizmoDrag()).toBe(true);
    expect(controller.updateDragPivot(pivot.clone().add(new THREE.Vector3(3, -4, 5)))).toBe(true);
    expect(volumes.map((v) => v.instanceTransform.offset)).toEqual([
      [3, -4, 5], [3, -4, 5], [23, 1, 5], [23, 1, 5],
    ]);
    expect(controller.endDrag()).toBe(true);
    expect(controller.owner).toBe('none');
  });

  it('moves every selected instance by an equal body-drag delta', () => {
    controller.selectFromHit(volumes[0], false);
    controller.selectFromHit(volumes[2], true);
    const pivot = controller.selectionPivot()!;

    expect(controller.tryBeginBodyDrag()).toBe(true);
    expect(controller.updateDragPivot(pivot.clone().add(new THREE.Vector3(-2, 7, 1)))).toBe(true);
    expect(volumes.map((v) => v.instanceTransform.offset)).toEqual([
      [-2, 7, 1], [-2, 7, 1], [18, 12, 1], [18, 12, 1],
    ]);
    expect(controller.endDrag()).toBe(true);
    expect(controller.selectFromClick(volumes[0], false)).toBe(false);
    expect(controller.selectedVolumes()).toEqual(volumes);
  });

  it('gives a gizmo grabber priority over body dragging', () => {
    controller.selectFromHit(volumes[0], false);
    controller.registerGizmoGrabberHitTest(() => true);

    expect(controller.resolveGizmoPointerDown({} as PointerEvent)).toBe(true);
    expect(controller.tryBeginBodyDrag()).toBe(false);
    expect(controller.owner).toBe('none');
    expect(controller.beginGizmoDrag()).toBe(true);
    expect(controller.owner).toBe('gizmo');
    expect(controller.tryBeginBodyDrag()).toBe(false);
  });

  it('drops the aggregate selection to bed and resets each selected instance', () => {
    controller.selectFromHit(volumes[0], false);
    controller.selectFromHit(volumes[2], true);

    expect(controller.dropSelectionToBed()).toBe(true);
    expect(volumes.map((v) => v.instanceTransform.offset[2])).toEqual([2, 2, 2, 2]);
    expect(controller.resetSelection()).toBe(true);
    expect(volumes.map((v) => v.instanceTransform.offset)).toEqual([
      [0, 0, 0], [0, 0, 0], [20, 5, 0], [20, 5, 0],
    ]);
  });

  it('prunes stale selection IDs when a model reload replaces the collection', () => {
    controller.selectFromHit(volumes[0], false);
    volumes = [makeVolume(1, 0, 0, [0, 0, 0])];

    expect(controller.pruneSelection()).toBe(true);
    expect(controller.selection.empty).toBe(true);
    expect(controller.gizmo).toBeNull();
  });
});
