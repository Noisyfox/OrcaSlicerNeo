import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { ModelObjectBuffer } from '@slicer/client';
import { GLVolume } from './GLVolume';
import { SceneInteractionController } from './SceneInteractionController';
import { EULER_ORDER } from './transformDeltaMath';

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

/** True world min-Z over the volume's actual (instance-transformed) vertices. */
function geometryMinZ(volume: GLVolume): number {
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...volume.instanceTransform.offset),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...volume.instanceTransform.rotation, EULER_ORDER)),
    new THREE.Vector3(...volume.instanceTransform.scale),
  );
  const position = volume.geometry.getAttribute('position');
  let minZ = Infinity;
  const vertex = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i).applyMatrix4(matrix);
    if (vertex.z < minZ) minZ = vertex.z;
  }
  return minZ;
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

  /** Identity world→screen projector: instance 0 spans [-1,1]², instance 1 [19,21]×[4,6]. */
  function registerFlatProjector(): void {
    controller.registerBoxSelectProjector((world) => ({ x: world.x, y: world.y }));
  }

  it('never auto-opens the gizmo on selection — the toggle is its only opener', () => {
    controller.selectFromHit(volumes[0], false);
    expect(controller.gizmo).toBeNull();
    expect(controller.selectedVolumes()).toEqual([volumes[0], volumes[1]]);

    controller.selectFromHit(volumes[2], true);
    expect(controller.gizmo).toBeNull();
  });

  it('selectFromHit expands per the active selection mode', () => {
    expect(controller.setSelectionMode('object')).toBe(true);
    controller.selectFromHit(volumes[0], false);
    expect(controller.selectedVolumes()).toEqual(volumes);

    expect(controller.setSelectionMode('volume')).toBe(true);
    controller.selectFromHit(volumes[1], false);
    // Orca: a part selection is anchored to the clicked instance.
    expect(controller.selectedVolumes()).toEqual([volumes[1]]);
  });

  it('setSelectionMode is a no-op when the mode is unchanged', () => {
    expect(controller.setSelectionMode('instance')).toBe(false);
  });

  it('selectComposite selects a target by object, volume, or instance width', () => {
    expect(controller.selectComposite(0)).toBe(true);
    expect(controller.selectedVolumes()).toEqual(volumes);

    expect(controller.selectComposite(0, 1)).toBe(true);
    // A part target is anchored to instance 0 (default) in Orca.
    expect(controller.selectedVolumes()).toEqual([volumes[1]]);

    expect(controller.selectComposite(0, undefined, 0)).toBe(true);
    expect(controller.selectedVolumes()).toEqual([volumes[0], volumes[1]]);

    // Additive toggle of the target instance clears it.
    expect(controller.selectComposite(0, undefined, 0, true)).toBe(true);
    expect(controller.selectedVolumes()).toHaveLength(0);
  });

  it('selectVolumeIds replaces or unions raw volume IDs', () => {
    expect(controller.selectVolumeIds(['0:0:0', '0:1:0'])).toBe(true);
    expect(controller.selectedVolumes()).toEqual([volumes[0], volumes[1]]);
    // Additive union of the other instance's volumes.
    expect(controller.selectVolumeIds(['0:0:1', '0:1:1'], true)).toBe(true);
    expect(controller.selectedVolumes()).toEqual(volumes);
  });

  it('classifies the selection like Orca (object/instance/part/mixed)', () => {
    expect(controller.computeSelectionKind()).toBe('empty');

    controller.selectVolumeIds(['0:0:0', '0:1:0', '0:0:1', '0:1:1']);
    expect(controller.computeSelectionKind()).toBe('object');

    controller.selectVolumeIds(['0:0:0', '0:1:0']);
    expect(controller.computeSelectionKind()).toBe('instance');

    controller.selectVolumeIds(['0:0:0']);
    expect(controller.computeSelectionKind()).toBe('part');

    // A part of instance 0 plus a part of instance 1 is Orca's Mixed.
    controller.selectVolumeIds(['0:0:0', '0:0:1']);
    expect(controller.computeSelectionKind()).toBe('mixed');
  });

  it('allows mixing a full instance and a full object (both Instance-mode)', () => {
    // A second, single-part/single-instance object (index 1) alongside the two-
    // volume/two-instance object (index 0) from the shared fixture.
    const multiVolumes = [
      ...volumes,
      makeVolume(1, 0, 0, [40, 0, 0]),
    ];
    const multi = new SceneInteractionController(() => multiVolumes);

    // A full instance of object 0 plus the whole object 1 is all Instance-mode
    // (an instance is a full object at that level), so it is valid, NOT Mixed.
    expect(multi.classifyVolumeIds(['0:0:0', '0:1:0', '1:0:0'])).toBe('object');

    // The guard therefore allows the additive toggle.
    multi.selectVolumeIds(['0:0:0', '0:1:0']);
    expect(multi.computeSelectionKind()).toBe('instance');
    expect(multi.selectComposite(1, 0, 0, true)).toBe(true);
    expect(multi.computeSelectionKind()).toBe('object');

    // Selecting both objects in full is also 'object'.
    expect(multi.selectVolumeIds(['0:0:0', '0:1:0', '0:0:1', '0:1:1', '1:0:0'])).toBe(true);
    expect(multi.computeSelectionKind()).toBe('object');
  });

  it('refuses additive viewport selection that would create Mixed (Orca)', () => {
    controller.selectVolumeIds(['0:0:0', '0:1:0', '0:0:1', '0:1:1']); // whole object
    expect(controller.computeSelectionKind()).toBe('object');
    const before = controller.selectedVolumes().length;
    // Ctrl+clicking a part of the full object would leave a partial instance ->
    // Mixed -> refused.
    expect(controller.selectComposite(0, 0, 0, true)).toBe(false);
    expect(controller.selectedVolumes()).toHaveLength(before);
    // Toggling a whole instance off is a valid object -> instance transition.
    expect(controller.selectComposite(0, undefined, 1, true)).toBe(true);
    expect(controller.computeSelectionKind()).toBe('instance');
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

  it('reports unique sorted object indices behind the selection', () => {
    const mixed = [
      ...volumes,
      makeVolume(1, 0, 0, [0, 0, 0]),
      makeVolume(2, 0, 0, [0, 0, 0]),
    ];
    const c = new SceneInteractionController(() => mixed);
    expect(c.selectedObjectIndices()).toEqual([]);

    // Selecting an instance of object 0 expands to its complete instance.
    c.selectFromHit(mixed[0], false);
    expect(c.selectedObjectIndices()).toEqual([0]);

    c.selectFromHit(mixed[4], true);
    c.selectFromHit(mixed[5], true);
    expect(c.selectedObjectIndices()).toEqual([0, 1, 2]);

    c.clearSelection();
    expect(c.selectedObjectIndices()).toEqual([]);
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

  it('claims a Shift+drag press for box selection and tracks the live marquee rect', () => {
    expect(controller.beginBoxSelect({ x: 10, y: 10 }, false)).toBe(true);
    expect(controller.owner).toBe('box');
    expect(controller.boxSelectionRect).toEqual({ x: 10, y: 10, width: 0, height: 0 });

    // A drag into the negative direction normalizes to a valid rect.
    expect(controller.updateBoxSelect({ x: 2, y: 4 })).toBe(true);
    expect(controller.boxSelectionRect).toEqual({ x: 2, y: 4, width: 8, height: 6 });
    expect(controller.cancelBoxSelect()).toBe(true);
    expect(controller.owner).toBe('none');
    expect(controller.boxSelectionRect).toBeNull();
  });

  it('refuses to preempt a gizmo press or an active pointer owner', () => {
    controller.resolveGizmoPointerDown({ button: 0 } as PointerEvent);
    expect(controller.beginBoxSelect({ x: 0, y: 0 }, false)).toBe(true);
    // A second press while the box owns the pointer is refused.
    expect(controller.beginBoxSelect({ x: 5, y: 5 }, false)).toBe(false);
    // No projector is registered here, so the end finalizes without a hit.
    expect(controller.endBoxSelect()).toBe(false);
    expect(controller.owner).toBe('none');

    controller.selectFromHit(volumes[0], false);
    expect(controller.tryBeginBodyDrag()).toBe(true);
    expect(controller.beginBoxSelect({ x: 0, y: 0 }, false)).toBe(false);
  });

  it('box-selects the complete instances whose projected bounds intersect the marquee', () => {
    registerFlatProjector();
    controller.beginBoxSelect({ x: -5, y: -5 }, false);
    controller.updateBoxSelect({ x: 5, y: 5 });

    expect(controller.endBoxSelect()).toBe(true);
    expect(controller.selectedVolumes()).toEqual([volumes[0], volumes[1]]);

    // A marquee over the second instance alone replaces the selection.
    controller.beginBoxSelect({ x: 15, y: 0 }, false);
    controller.updateBoxSelect({ x: 25, y: 10 });
    expect(controller.endBoxSelect()).toBe(true);
    expect(controller.selectedVolumes()).toEqual([volumes[2], volumes[3]]);
    expect(controller.selectionInstanceCount).toBe(1);
  });

  it('box-selects additively when the press carried Ctrl/Cmd', () => {
    registerFlatProjector();
    controller.selectFromHit(volumes[0], false);

    controller.beginBoxSelect({ x: 15, y: 0 }, true);
    controller.updateBoxSelect({ x: 25, y: 10 });
    expect(controller.endBoxSelect()).toBe(true);
    expect(controller.selectedVolumes()).toEqual(volumes);
  });

  it('clears the selection when a replace marquee covers nothing', () => {
    registerFlatProjector();
    controller.selectFromHit(volumes[0], false);

    controller.beginBoxSelect({ x: 100, y: 100 }, false);
    controller.updateBoxSelect({ x: 120, y: 120 });
    expect(controller.endBoxSelect()).toBe(true);
    expect(controller.selection.empty).toBe(true);
  });

  it('leaves selection untouched without a registered projector', () => {
    controller.selectFromHit(volumes[0], false);
    controller.beginBoxSelect({ x: -5, y: -5 }, false);
    controller.updateBoxSelect({ x: 5, y: 5 });

    expect(controller.endBoxSelect()).toBe(false);
    expect(controller.selectedVolumes()).toEqual([volumes[0], volumes[1]]);
  });

  it('abandons an active marquee when the selection is cleared or the model resets', () => {
    controller.beginBoxSelect({ x: 0, y: 0 }, false);
    controller.updateBoxSelect({ x: 10, y: 10 });
    expect(controller.clearSelection()).toBe(true);
    expect(controller.boxSelectionRect).toBeNull();
    expect(controller.owner).toBe('none');

    controller.beginBoxSelect({ x: 0, y: 0 }, false);
    controller.updateBoxSelect({ x: 10, y: 10 });
    controller.resetForModel();
    expect(controller.boxSelectionRect).toBeNull();
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
    expect(controller.dropSelectionToBed()).toBe(true);
    // The drop must land the ACTUAL mesh on the plate (min-Z over the real
    // transformed vertices), not the loose local-bbox AABB which under-counts.
    const trueMinZ = geometryMinZ(volumes[0]);
    expect(trueMinZ).toBeCloseTo(0, 8);
  });

  it('drops an arbitrarily-rotated model onto the plate (reported angles)', () => {
    // The exact rotation the user hit: a general (non-axis-aligned) Euler
    // whose rotated local-bbox AABB extends below the true mesh low point.
    const radians = (d: number) => (d * Math.PI) / 180;
    for (const volume of [volumes[0], volumes[1]]) {
      volume.instanceTransform.offset = [10, 10, 40];
      volume.instanceTransform.rotation = [radians(-16), radians(41.8), radians(163.8)];
    }
    controller.selectFromHit(volumes[0], false);
    // Before the drop the true mesh is clearly off the plate.
    expect(geometryMinZ(volumes[0])).toBeGreaterThan(1);
    expect(controller.dropSelectionToBed()).toBe(true);
    // After the drop the ACTUAL vertices touch the plate (min-Z === 0), even
    // though the loose AABB would still extend below zero.
    expect(geometryMinZ(volumes[0])).toBeCloseTo(0, 6);
    expect(geometryMinZ(volumes[1])).toBeCloseTo(0, 6);
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

  it('snaps the selection bounds to the actual vertices of a rotated model', () => {
    // A slanted shape whose local AABB corners extend beyond the true mesh.
    // The tetrahedron only occupies the [0,1]³ vertices it owns, so after a
    // 45° X rotation the loose local-bbox AABB would reach z = √2 while the
    // real mesh only tops out at ½√2. The selection box must use the real
    // transformed vertices, exactly like OrcaSlicer's World reference system.
    const buffer: ModelObjectBuffer = {
      objectIdx: 0,
      volumeIdx: 0,
      instanceIdx: 0,
      positions: new Float32Array([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
      ]),
      vertexCount: 4,
      indices: new Uint32Array([0, 1, 2]),
      indexCount: 3,
      offset: [0, 0, 0],
      instanceTransform: { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] },
      volumeTransform: { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] },
    };
    const volume = new GLVolume(buffer);
    volume.instanceTransform.rotation = [Math.PI / 4, 0, 0];
    const c = new SceneInteractionController(() => [volume]);
    c.selectFromHit(volume, false);

    const bounds = c.selectionBounds()!;
    const s = Math.SQRT1_2; // ½√2 ≈ 0.7071
    // World-axis aligned (never rotates with the model) and tight to the real
    // transformed vertices: z tops out at ½√2, not the loose box's √2.
    expect(bounds.min.x).toBeCloseTo(0, 8);
    expect(bounds.min.y).toBeCloseTo(-s, 8);
    expect(bounds.min.z).toBeCloseTo(0, 8);
    expect(bounds.max.x).toBeCloseTo(1, 8);
    expect(bounds.max.y).toBeCloseTo(s, 8);
    expect(bounds.max.z).toBeCloseTo(s, 8);
  });
});

describe('part-scoped (volume) transforms', () => {
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

  it('detects a part-scoped selection from a volume composite', () => {
    expect(controller.selectComposite(0, 1)).toBe(true);
    expect(controller.isVolumeScopedSelection()).toBe(true);
    expect(controller.selectComposite(0)).toBe(true);
    expect(controller.isVolumeScopedSelection()).toBe(false);
    expect(controller.selectComposite(0, undefined, 0)).toBe(true);
    expect(controller.isVolumeScopedSelection()).toBe(false);
  });

  it('Alt+click (part) selects the individual volume composite', () => {
    expect(controller.selectFromHit(volumes[0], false, true)).toBe(true);
    // Orca: a part is anchored to the clicked instance (a single volume), which
    // is a part-scoped selection so a subsequent drag moves only that part.
    expect(controller.selectedVolumes()).toEqual([volumes[0]]);
    expect(controller.isVolumeScopedSelection()).toBe(true);
  });

  it('moves only the selected part, not the whole instance', () => {
    const instanceTransforms = volumes.map((volume) => structuredClone(volume.instanceTransform));
    controller.selectComposite(0, 1);
    controller.moveSelectionBy(new THREE.Vector3(10, 0, 0));
    // The selected part's ModelVolume transform is shared by every instance;
    // the sibling part and all per-instance transforms remain unchanged.
    expect(volumes[1].volumeTransform.offset[0]).toBeCloseTo(10, 6);
    expect(volumes[3].volumeTransform.offset[0]).toBeCloseTo(10, 6);
    expect(volumes[0].volumeTransform.offset[0]).toBeCloseTo(0, 6);
    expect(volumes[2].volumeTransform.offset[0]).toBeCloseTo(0, 6);
    expect(volumes.map((volume) => volume.instanceTransform)).toEqual(instanceTransforms);
  });

  it('scales every instance copy of the selected part', () => {
    const instanceTransforms = volumes.map((volume) => structuredClone(volume.instanceTransform));
    controller.selectComposite(0, 0);
    controller.scaleSelectionBy([2, 1, 1]);
    expect(volumes[0].volumeTransform.scale[0]).toBeCloseTo(2, 6);
    expect(volumes[2].volumeTransform.scale[0]).toBeCloseTo(2, 6);
    expect(volumes[1].volumeTransform.scale[0]).toBeCloseTo(1, 6);
    expect(volumes[3].volumeTransform.scale[0]).toBeCloseTo(1, 6);
    expect(volumes.map((volume) => volume.instanceTransform)).toEqual(instanceTransforms);
  });
});
