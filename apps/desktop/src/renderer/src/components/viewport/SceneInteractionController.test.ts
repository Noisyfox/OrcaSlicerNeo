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

    controller.registerGizmoGrabberHitTest(() => true);
    controller.resolveGizmoPointerDown({ button: 0 } as PointerEvent);
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

  it('preserves a multi-selection when a body drag begins on one of its members', () => {
    controller.selectFromHit(volumes[0], false);
    controller.selectFromHit(volumes[2], true);
    controller.resolveGizmoPointerDown({ button: 0 } as PointerEvent);
    const pivot = controller.selectionPivot()!;

    expect(controller.prepareBodyDragFromPointerDown(volumes[0], false)).toBe(false);
    expect(controller.selectedVolumes()).toEqual(volumes);
    expect(controller.tryBeginBodyDrag()).toBe(true);
    expect(controller.updateDragPivot(pivot.clone().add(new THREE.Vector3(3, 7, 1)))).toBe(true);
    expect(volumes.map((v) => v.instanceTransform.offset)).toEqual([
      [3, 7, 1], [3, 7, 1], [23, 12, 1], [23, 12, 1],
    ]);
  });

  it('selects an unselected body at pointer-down so that same press can drag it', () => {
    controller.resolveGizmoPointerDown({ button: 0 } as PointerEvent);

    expect(controller.prepareBodyDragFromPointerDown(volumes[2], false)).toBe(true);
    expect(controller.selectedVolumes()).toEqual([volumes[2], volumes[3]]);
    expect(controller.bodyDragEnabled).toBe(true);
    expect(controller.tryBeginBodyDrag()).toBe(true);
    expect(controller.owner).toBe('body');
  });

  it('gives a gizmo grabber priority over body dragging', () => {
    controller.selectFromHit(volumes[0], false);
    controller.registerGizmoGrabberHitTest(() => true);

    expect(controller.resolveGizmoPointerDown({ button: 0 } as PointerEvent)).toBe(true);
    expect(controller.prepareBodyDragFromPointerDown(volumes[2], false)).toBe(false);
    expect(controller.selectedVolumes()).toEqual([volumes[0], volumes[1]]);
    expect(controller.tryBeginBodyDrag()).toBe(false);
    expect(controller.owner).toBe('none');
    expect(controller.beginGizmoDrag()).toBe(true);
    expect(controller.owner).toBe('gizmo');
    expect(controller.tryBeginBodyDrag()).toBe(false);
  });

  it('keeps a body press when the cursor reaches a gizmo grabber before drag start', () => {
    controller.selectFromHit(volumes[0], false);
    controller.registerGizmoGrabberHitTest(() => false);

    // DragControls has not crossed its movement threshold yet, so there is
    // no active body gesture. Moving onto a handle must not reassign this
    // already-started press to TransformControls.
    expect(controller.resolveGizmoPointerDown({ button: 0 } as PointerEvent)).toBe(false);
    controller.setGizmoGrabberHovered(true);
    expect(controller.bodyDragEnabled).toBe(true);
    expect(controller.beginGizmoDrag()).toBe(false);
    expect(controller.tryBeginBodyDrag()).toBe(true);
    expect(controller.owner).toBe('body');
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
