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

  it('never auto-opens the gizmo on selection — the toggle is its only opener', () => {
    controller.selectFromHit(volumes[0], false);
    expect(controller.gizmo).toBeNull();
    expect(controller.selectedVolumes()).toEqual([volumes[0], volumes[1]]);

    controller.selectFromHit(volumes[2], true);
    expect(controller.gizmo).toBeNull();
  });

  it('can only arm the move gizmo with a non-empty selection', () => {
    // An empty selection makes the toggle a no-op — the gizmo can only be
    // activated while something is selected.
    expect(controller.toggleGizmo('move')).toBe(false);
    expect(controller.gizmo).toBeNull();

    expect(controller.selectFromHit(volumes[0], false)).toBe(true);
    expect(controller.toggleGizmo('move')).toBe(true);
    expect(controller.gizmo).toBe('move');
    // Arming never happens implicitly — even an additive selection while
    // armed leaves the state exactly as toggled.
    expect(controller.selectFromHit(volumes[2], true)).toBe(true);
    expect(controller.gizmo).toBe('move');

    expect(controller.toggleGizmo('move')).toBe(false);
    expect(controller.gizmo).toBeNull();
    // Selection changes never reopen a disarmed gizmo.
    expect(controller.selectFromHit(volumes[0], false)).toBe(true);
    expect(controller.gizmo).toBeNull();
  });

  it('auto-closes an armed gizmo when the selection is cleared', () => {
    controller.selectFromHit(volumes[0], false);
    controller.toggleGizmo('move');
    expect(controller.gizmo).toBe('move');

    controller.clearSelection();
    expect(controller.gizmo).toBeNull();
    expect(controller.owner).toBe('none');
  });

  it('refuses a gizmo drag while the gizmo is not toggled on', () => {
    controller.selectFromHit(volumes[0], false);
    controller.registerGizmoGrabberHitTest(() => true);

    expect(controller.resolveGizmoPointerDown({ button: 0 } as PointerEvent)).toBe(true);
    expect(controller.pointerStartsOnGizmo).toBe(true);
    expect(controller.beginGizmoDrag()).toBe(false);
    expect(controller.owner).toBe('none');
  });

  it('moves every selected instance by an equal gesture delta and preserves spacing', () => {
    controller.selectFromHit(volumes[0], false);
    controller.selectFromHit(volumes[2], true);
    const pivot = controller.selectionPivot()!;
    controller.toggleGizmo('move');

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

  it('keeps the complete selection when a gizmo drag ends over one member', () => {
    controller.selectFromHit(volumes[0], false);
    controller.selectFromHit(volumes[2], true);
    controller.toggleGizmo('move');
    controller.registerGizmoGrabberHitTest(() => true);
    controller.resolveGizmoPointerDown({ button: 0 } as PointerEvent);

    expect(controller.beginGizmoDrag()).toBe(true);
    expect(controller.endDrag()).toBe(true);
    expect(controller.selectFromClick(volumes[0], false)).toBe(false);
    expect(controller.selectedVolumes()).toEqual(volumes);
  });

  it('keeps the complete selection on a plain click of an existing member', () => {
    controller.selectFromHit(volumes[0], false);
    controller.selectFromHit(volumes[2], true);

    expect(controller.selectFromClick(volumes[0], false)).toBe(false);
    expect(controller.selectedVolumes()).toEqual(volumes);
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
    controller.toggleGizmo('move');
    controller.registerGizmoGrabberHitTest(() => true);

    expect(controller.resolveGizmoPointerDown({ button: 0 } as PointerEvent)).toBe(true);
    expect(controller.pointerStartsOnGizmo).toBe(true);
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
    controller.toggleGizmo('move');
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

  it('prunes stale selection IDs and auto-closes an armed gizmo when a model reload replaces the collection', () => {
    controller.selectFromHit(volumes[0], false);
    controller.toggleGizmo('move');
    expect(controller.gizmo).toBe('move');
    volumes = [makeVolume(1, 0, 0, [0, 0, 0])];

    expect(controller.pruneSelection()).toBe(true);
    expect(controller.selection.empty).toBe(true);
    expect(controller.gizmo).toBeNull();
  });

  it('toggles rotate/scale modes exclusively and switches between them', () => {
    controller.selectFromHit(volumes[0], false);
    expect(controller.toggleGizmo('rotate')).toBe(true);
    expect(controller.gizmo).toBe('rotate');
    // Switching to another armed mode changes modes instead of disarming.
    expect(controller.toggleGizmo('scale')).toBe(true);
    expect(controller.gizmo).toBe('scale');
    // Toggling the armed mode disarms.
    expect(controller.toggleGizmo('scale')).toBe(false);
    expect(controller.gizmo).toBeNull();
    // The toolbar can never arm with an empty selection.
    controller.clearSelection();
    expect(controller.toggleGizmo('rotate')).toBe(false);
  });

  it('forces world scale space while multi-selected', () => {
    controller.selectFromHit(volumes[0], false);
    expect(controller.setScaleSpace('local')).toBe(true);
    expect(controller.scaleSpace).toBe('local');
    // A second instance is added — local is no longer representable.
    controller.selectFromHit(volumes[2], true);
    expect(controller.setScaleSpace('local')).toBe(false);
    expect(controller.scaleSpace).toBe('local');
    // Back to a single instance: local is accepted again.
    controller.clearSelection();
    controller.selectFromHit(volumes[0], false);
    expect(controller.setScaleSpace('local')).toBe(false);
    expect(controller.scaleSpace).toBe('local');
  });

  it('reports the single selection orientation and null for a group', () => {
    volumes[0].instanceTransform.rotation = [0, 0, Math.PI / 2];
    controller.selectFromHit(volumes[0], false);
    const orientation = controller.selectionOrientation()!;
    expect(orientation.z).toBeCloseTo(Math.SQRT1_2, 8);
    expect(orientation.w).toBeCloseTo(Math.SQRT1_2, 8);

    controller.selectFromHit(volumes[2], true);
    expect(controller.selectionOrientation()).toBeNull();
  });

  it('rotates every selected instance rigidly around the pivot during a gizmo drag', () => {
    controller.selectFromHit(volumes[0], false);
    controller.selectFromHit(volumes[2], true);
    controller.toggleGizmo('rotate');
    const pivotGroup = new THREE.Group();
    pivotGroup.position.copy(controller.selectionPivot()!);
    controller.attachPivot(pivotGroup);
    controller.registerGizmoGrabberHitTest(() => true);
    controller.resolveGizmoPointerDown({ button: 0 } as PointerEvent);
    expect(controller.beginGizmoDrag()).toBe(true);

    pivotGroup.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    expect(controller.updateGizmoTransform({
      position: pivotGroup.position,
      quaternion: pivotGroup.quaternion,
      scale: pivotGroup.scale,
    })).toBe(true);

    // Pivot (10, 2.5, 0): instance 0 orbits to (12.5, -7.5, 0), instance 2
    // orbits to (7.5, 12.5, 0); both rotations gain +90° about Z.
    const offsets = volumes.map((v) => v.instanceTransform.offset);
    const expected = [
      [12.5, -7.5, 0], [12.5, -7.5, 0], [7.5, 12.5, 0], [7.5, 12.5, 0],
    ];
    for (let i = 0; i < offsets.length; i++) {
      for (let axis = 0; axis < 3; axis++) {
        expect(offsets[i][axis]).toBeCloseTo(expected[i][axis], 8);
      }
    }
    for (const volume of volumes) {
      expect(volume.instanceTransform.rotation[2]).toBeCloseTo(Math.PI / 2, 8);
    }
    expect(controller.endDrag()).toBe(true);
  });

  it('scales every selected instance around the pivot in world space', () => {
    controller.selectFromHit(volumes[0], false);
    controller.selectFromHit(volumes[2], true);
    controller.toggleGizmo('scale');
    const pivotGroup = new THREE.Group();
    pivotGroup.position.copy(controller.selectionPivot()!);
    controller.attachPivot(pivotGroup);
    controller.registerGizmoGrabberHitTest(() => true);
    controller.resolveGizmoPointerDown({ button: 0 } as PointerEvent);
    expect(controller.beginGizmoDrag()).toBe(true);

    pivotGroup.scale.set(2, 1, 1);
    expect(controller.updateGizmoTransform({
      position: pivotGroup.position,
      quaternion: pivotGroup.quaternion,
      scale: pivotGroup.scale,
    })).toBe(true);

    expect(volumes.map((v) => v.instanceTransform.offset)).toEqual([
      [-10, 0, 0], [-10, 0, 0], [30, 5, 0], [30, 5, 0],
    ]);
    expect(volumes.map((v) => v.instanceTransform.scale)).toEqual([
      [2, 1, 1], [2, 1, 1], [2, 1, 1], [2, 1, 1],
    ]);
  });

  it('scales along the object axes when the pivot carries the local orientation', () => {
    volumes[0].instanceTransform.rotation = [0, 0, Math.PI / 2];
    controller.selectFromHit(volumes[0], false);
    controller.toggleGizmo('scale');
    const pivotGroup = new THREE.Group();
    pivotGroup.position.copy(controller.selectionPivot()!);
    pivotGroup.quaternion.copy(controller.selectionOrientation()!);
    controller.attachPivot(pivotGroup);
    controller.registerGizmoGrabberHitTest(() => true);
    controller.resolveGizmoPointerDown({ button: 0 } as PointerEvent);
    expect(controller.beginGizmoDrag()).toBe(true);

    pivotGroup.scale.set(2, 1, 1);
    expect(controller.updateGizmoTransform({
      position: pivotGroup.position,
      quaternion: pivotGroup.quaternion,
      scale: pivotGroup.scale,
    })).toBe(true);
    expect(controller.selectedVolumes().map((v) => v.instanceTransform.scale)).toEqual([
      [2, 1, 1], [2, 1, 1],
    ]);
  });

  it('applies panel rotation deltas to every selected instance', () => {
    controller.selectFromHit(volumes[0], false);
    controller.selectFromHit(volumes[2], true);
    expect(controller.rotateSelectionBy([0, 0, Math.PI / 2])).toBe(true);
    for (const volume of volumes) {
      expect(volume.instanceTransform.rotation[2]).toBeCloseTo(Math.PI / 2, 8);
    }
  });

  it('applies panel scale factors and size edits rigidly about the pivot', () => {
    controller.selectFromHit(volumes[0], false);
    controller.selectFromHit(volumes[2], true);
    expect(controller.scaleSelectionBy([2, 1, 1])).toBe(true);
    expect(volumes.map((v) => v.instanceTransform.scale)).toEqual([
      [2, 1, 1], [2, 1, 1], [2, 1, 1], [2, 1, 1],
    ]);
    // Rigid scaling about the aggregate pivot keeps the selection centered:
    // instance 0's offset orbits from (0,0,0) to (-10,0,0) (X only).
    expect(volumes[0].instanceTransform.offset).toEqual([-10, 0, 0]);
    expect(volumes[2].instanceTransform.offset).toEqual([30, 5, 0]);
    expect(controller.selectionBounds()!.getCenter(new THREE.Vector3()).x).toBeCloseTo(10, 8);

    // Aggregate width after the edit: union [-12,32] = 44 → target 22 halves
    // it and returns the offsets to their starting points.
    expect(controller.scaleSelectionToSize(0, 22)).toBe(true);
    expect(controller.selectionBounds()!.getSize(new THREE.Vector3()).x).toBeCloseTo(22, 8);
    expect(volumes[0].instanceTransform.scale[0]).toBeCloseTo(1, 8);
    expect(volumes[0].instanceTransform.offset).toEqual([0, 0, 0]);
    expect(controller.scaleSelectionToSize(1, 0)).toBe(false);
  });

  it('resets rotation and scale to the load-time transform', () => {
    volumes[0].instanceTransform.rotation = [0, 0, Math.PI / 2];
    volumes[0].instanceTransform.scale = [3, 3, 3];
    controller.selectFromHit(volumes[0], false);
    expect(controller.resetSelectionRotation()).toBe(true);
    expect(volumes[0].instanceTransform.rotation).toEqual([0, 0, 0]);
    expect(controller.resetSelectionScale()).toBe(true);
    expect(volumes[0].instanceTransform.scale).toEqual([1, 1, 1]);
  });

  it('drops a rotated, floating selection to the bed', () => {
    // Tilt the single instance and lift it well off the plate so its world
    // min-Z is clearly non-zero.
    for (const volume of [volumes[0], volumes[1]]) {
      volume.instanceTransform.offset = [10, 10, 30];
      volume.instanceTransform.rotation = [Math.PI / 4, 0, 0];
    }
    controller.selectFromHit(volumes[0], false);
    const before = controller.selectionBounds()!;
    expect(before.min.z).toBeGreaterThan(0);

    expect(controller.dropSelectionToBed()).toBe(true);
    const after = controller.selectionBounds()!;
    expect(after.min.z).toBeCloseTo(0, 8);
  });

  it('scales a rotated selection along the world axis', () => {
    // Rotate 90° about Z — local Y becomes world X. A world-X ×2 must double
    // the world bbox X size (not the local-X/Y swap the naive T·R·S gives).
    for (const volume of [volumes[0], volumes[1]]) {
      volume.instanceTransform.rotation = [0, 0, Math.PI / 2];
    }
    controller.selectFromHit(volumes[0], false);
    const widthXBefore = controller.selectionBounds()!.getSize(new THREE.Vector3()).x;
    expect(controller.scaleSelectionBy([2, 1, 1])).toBe(true);
    const widthXAfter = controller.selectionBounds()!.getSize(new THREE.Vector3()).x;
    expect(widthXAfter).toBeCloseTo(widthXBefore * 2, 8);
  });
});
