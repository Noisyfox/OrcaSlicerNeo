import * as THREE from 'three';
import type { ModelTransform } from '@slicer/client';
import type { Vec3 } from '../../lib/vec3';
import { GLVolume } from './GLVolume';
import { instanceKeyOf, Selection, type InstanceKey } from './Selection';

export type OpenGizmo = 'move' | null;
export type PointerOwner = 'none' | 'gizmo' | 'body';
type PointerOrigin = 'none' | 'gizmo' | 'non-gizmo';

export interface DragSnapshot {
  readonly kind: Exclude<PointerOwner, 'none'>;
  readonly startPivot: THREE.Vector3;
  readonly startInstances: ReadonlyMap<InstanceKey, ModelTransform>;
}

/**
 * The viewport scene's single owner for selection and interaction state.
 *
 * It intentionally has no bridge dependency: edits change local GLVolume
 * state and the toolbar synchronizes that state just before a slice.
 */
export class SceneInteractionController {
  readonly selection = new Selection();

  private readonly listeners = new Set<() => void>();
  private openGizmo: OpenGizmo = null;
  private pointerOwner: PointerOwner = 'none';
  // DragControls deliberately waits for a small movement threshold before it
  // calls onDragStart. Keep the pointer-down hit result separately so a fast
  // move from a model body onto a handle cannot change that gesture into a
  // gizmo drag during the threshold window.
  private pointerOrigin: PointerOrigin = 'none';
  private gizmoGrabberHovered = false;
  private gizmoGrabberHitTest: ((event: PointerEvent) => boolean) | null = null;
  private suppressPostBodyDragClick = false;
  private drag: DragSnapshot | null = null;

  constructor(private readonly getVolumes: () => readonly GLVolume[]) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get gizmo(): OpenGizmo { return this.openGizmo; }
  get owner(): PointerOwner { return this.pointerOwner; }
  get activeDrag(): DragSnapshot | null { return this.drag; }
  get bodyDragEnabled(): boolean {
    // The initiating DragControls must stay enabled for the rest of its own
    // gesture. A gizmo remains exclusive; other body wrappers are still
    // blocked synchronously by tryBeginBodyDrag/update ownership checks.
    return (this.pointerOrigin === 'non-gizmo' || !this.gizmoGrabberHovered)
      && (this.pointerOwner === 'none' || this.pointerOwner === 'body')
      && !this.selection.empty;
  }

  selectedVolumes(): GLVolume[] {
    return this.selection.volumes(this.getVolumes());
  }

  selectFromHit(hit: GLVolume, additive: boolean): boolean {
    const changed = additive
      ? this.selection.toggleFromHit(hit, this.getVolumes())
      : this.selection.replaceFromHit(hit, this.getVolumes());
    this.syncGizmoToSelection();
    if (changed) this.emit();
    return changed;
  }

  /** Preserve a multi-selection when the browser dispatches click after drag end. */
  selectFromClick(hit: GLVolume, additive: boolean): boolean {
    if (this.suppressPostBodyDragClick) {
      this.suppressPostBodyDragClick = false;
      return false;
    }
    return this.selectFromHit(hit, additive);
  }

  clearSelection(): boolean {
    const changed = this.selection.clear();
    this.cancelDrag();
    this.openGizmo = null;
    if (changed) this.emit();
    return changed;
  }

  /** Call after the renderer collection changes. */
  pruneSelection(): boolean {
    const changed = this.selection.prune(this.getVolumes());
    this.syncGizmoToSelection();
    if (this.drag && this.selectedVolumes().length === 0) this.cancelDrag();
    if (changed) this.emit();
    return changed;
  }

  setGizmoGrabberHovered(hovered: boolean): void {
    if (this.gizmoGrabberHovered === hovered) return;
    this.gizmoGrabberHovered = hovered;
    this.emit();
  }

  /** Register the live TransformControls picker owned by the sole gizmo. */
  registerGizmoGrabberHitTest(hitTest: ((event: PointerEvent) => boolean) | null): void {
    this.gizmoGrabberHitTest = hitTest;
  }

  /**
   * Called during the viewport's native pointer-capture phase. It rechecks
   * the TransformControls picker synchronously, before any DragControls
   * target callback can begin a body gesture.
   */
  resolveGizmoPointerDown(event: PointerEvent): boolean {
    if (event.button !== 0) return false;
    const grabbed = this.gizmoGrabberHitTest?.(event) ?? false;
    this.pointerOrigin = grabbed ? 'gizmo' : 'non-gizmo';
    this.setGizmoGrabberHovered(grabbed);
    return grabbed;
  }

  /** Release the pointer-down arbitration latch when no gesture owns it. */
  releasePointer(): void {
    if (this.pointerOwner !== 'none') return;
    this.pointerOrigin = 'none';
    this.setGizmoGrabberHovered(false);
  }

  /** Clear all ephemeral scene interaction when a loaded collection is replaced. */
  resetForModel(): void {
    const hadState = !this.selection.empty || this.openGizmo !== null || this.drag !== null || this.pointerOwner !== 'none';
    this.selection.clear();
    this.openGizmo = null;
    this.drag = null;
    this.suppressPostBodyDragClick = false;
    this.pointerOwner = 'none';
    this.pointerOrigin = 'none';
    this.gizmoGrabberHovered = false;
    if (hadState) this.emit();
  }

  /**
   * Claims a body-drag only when no TransformControls grabber owns or hovers
   * the pointer. The caller must not mutate a dragged group unless this
   * returns true.
   */
  tryBeginBodyDrag(): boolean {
    if (this.pointerOrigin === 'gizmo' || this.pointerOwner !== 'none' || this.selection.empty) return false;
    return this.beginDrag('body');
  }

  /** Called synchronously by TransformControls on a confirmed grabber press. */
  beginGizmoDrag(): boolean {
    if (this.pointerOrigin !== 'gizmo' || this.pointerOwner !== 'none' || this.selection.empty || this.openGizmo === null) return false;
    return this.beginDrag('gizmo');
  }

  /** Apply a world-space pivot position during an active gesture. */
  updateDragPivot(nextPivot: THREE.Vector3): boolean {
    if (!this.drag) return false;
    const delta = nextPivot.clone().sub(this.drag.startPivot);
    this.applySnapshotDelta(this.drag.startInstances, delta);
    this.emit();
    return true;
  }

  endDrag(): boolean {
    if (!this.drag) return false;
    const completedKind = this.drag.kind;
    this.drag = null;
    this.pointerOwner = 'none';
    this.pointerOrigin = 'none';
    this.gizmoGrabberHovered = false;
    this.suppressPostBodyDragClick = completedKind === 'body';
    this.emit();
    return true;
  }

  cancelDrag(): boolean {
    if (!this.drag) {
      this.pointerOwner = 'none';
      this.pointerOrigin = 'none';
      this.gizmoGrabberHovered = false;
      return false;
    }
    this.applySnapshotDelta(this.drag.startInstances, new THREE.Vector3());
    this.drag = null;
    this.pointerOwner = 'none';
    this.pointerOrigin = 'none';
    this.gizmoGrabberHovered = false;
    this.emit();
    return true;
  }

  selectionBounds(): THREE.Box3 | null {
    const selected = this.selectedVolumes();
    if (selected.length === 0) return null;
    const bounds = new THREE.Box3().makeEmpty();
    for (const volume of selected) bounds.union(worldBounds(volume));
    return bounds;
  }

  selectionPivot(): THREE.Vector3 | null {
    return this.selectionBounds()?.getCenter(new THREE.Vector3()) ?? null;
  }

  moveSelectionToPivot(nextPivot: THREE.Vector3): boolean {
    const pivot = this.selectionPivot();
    if (!pivot || this.selection.empty) return false;
    this.moveSelectionBy(nextPivot.clone().sub(pivot));
    return true;
  }

  moveSelectionBy(delta: THREE.Vector3): boolean {
    if (this.selection.empty) return false;
    this.applySnapshotDelta(this.captureSelectedInstances(), delta);
    this.emit();
    return true;
  }

  dropSelectionToBed(): boolean {
    const bounds = this.selectionBounds();
    if (!bounds) return false;
    return this.moveSelectionBy(new THREE.Vector3(0, 0, -bounds.min.z));
  }

  resetSelection(): boolean {
    const selected = this.selectedVolumes();
    if (selected.length === 0) return false;
    const initial = new Map<InstanceKey, ModelTransform>();
    for (const volume of selected) {
      const key = instanceKeyOf(volume);
      if (!initial.has(key)) initial.set(key, cloneTransform(volume.buffer.instanceTransform));
    }
    this.applyInstanceTransforms(initial);
    this.emit();
    return true;
  }

  private beginDrag(kind: Exclude<PointerOwner, 'none'>): boolean {
    const pivot = this.selectionPivot();
    if (!pivot) return false;
    this.pointerOwner = kind;
    this.drag = {
      kind,
      startPivot: pivot,
      startInstances: this.captureSelectedInstances(),
    };
    this.emit();
    return true;
  }

  private captureSelectedInstances(): Map<InstanceKey, ModelTransform> {
    const transforms = new Map<InstanceKey, ModelTransform>();
    for (const volume of this.selectedVolumes()) {
      const key = instanceKeyOf(volume);
      if (!transforms.has(key)) transforms.set(key, cloneTransform(volume.instanceTransform));
    }
    return transforms;
  }

  private applySnapshotDelta(snapshot: ReadonlyMap<InstanceKey, ModelTransform>, delta: THREE.Vector3): void {
    const next = new Map<InstanceKey, ModelTransform>();
    for (const [key, transform] of snapshot) {
      const moved = cloneTransform(transform);
      moved.offset = [
        transform.offset[0] + delta.x,
        transform.offset[1] + delta.y,
        transform.offset[2] + delta.z,
      ];
      next.set(key, moved);
    }
    this.applyInstanceTransforms(next);
  }

  private applyInstanceTransforms(transforms: ReadonlyMap<InstanceKey, ModelTransform>): void {
    for (const volume of this.getVolumes()) {
      const transform = transforms.get(instanceKeyOf(volume));
      if (transform) volume.instanceTransform = cloneTransform(transform);
    }
  }

  private syncGizmoToSelection(): void {
    this.openGizmo = this.selection.empty ? null : 'move';
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function worldBounds(volume: GLVolume): THREE.Box3 {
  if (!volume.geometry.boundingBox) volume.geometry.computeBoundingBox();
  const instance = transformMatrix(volume.instanceTransform);
  const part = transformMatrix(volume.volumeTransform);
  return volume.geometry.boundingBox!.clone().applyMatrix4(instance.multiply(part));
}

function transformMatrix(transform: ModelTransform): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...transform.offset),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...transform.rotation)),
    new THREE.Vector3(
      transform.scale[0] * transform.mirror[0],
      transform.scale[1] * transform.mirror[1],
      transform.scale[2] * transform.mirror[2],
    ),
  );
}

function cloneTransform(transform: ModelTransform): ModelTransform {
  return {
    offset: [...transform.offset] as Vec3,
    rotation: [...transform.rotation] as Vec3,
    scale: [...transform.scale] as Vec3,
    mirror: [...transform.mirror] as Vec3,
  };
}
