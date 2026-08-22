import * as THREE from 'three';
import type { ModelTransform } from '@slicer/client';
import type { Vec3 } from '../../lib/vec3';
import { GLVolume } from './GLVolume';
import { instanceKeyOf, Selection, type InstanceKey } from './Selection';
import {
  applyRotationDelta,
  applyScaleDelta,
  matrixFromTransform,
  normalizeTransform,
  quatFromRotation,
  transformFromMatrix,
} from './transformDeltaMath';
import {
  normalizeRect,
  rectsOverlap,
  unionRects,
  type BoxPoint,
  type BoxRect,
} from './boxSelectionMath';

export type OpenGizmo = 'move' | 'rotate' | 'scale' | null;
/** Scale gizmo handle space; multi-selection always scales in world space. */
export type ScaleSpace = 'world' | 'local';
export type PointerOwner = 'none' | 'gizmo' | 'body' | 'box';
type PointerOrigin = 'none' | 'gizmo' | 'non-gizmo';

export interface DragSnapshot {
  readonly kind: 'gizmo' | 'body';
  readonly startPivot: THREE.Vector3;
  readonly startQuaternion: THREE.Quaternion;
  readonly startScale: THREE.Vector3;
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
  private scaleSpaceState: ScaleSpace = 'world';
  private pointerOwner: PointerOwner = 'none';
  private pivot: THREE.Object3D | null = null;
  // DragControls deliberately waits for a small movement threshold before it
  // calls onDragStart. Keep the pointer-down hit result separately so a fast
  // move from a model body onto a handle cannot change that gesture into a
  // gizmo drag during the threshold window.
  private pointerOrigin: PointerOrigin = 'none';
  private gizmoGrabberHovered = false;
  private gizmoGrabberHitTest: ((event: PointerEvent) => boolean) | null = null;
  private suppressPostDragClick = false;
  private drag: DragSnapshot | null = null;
  private boxSelect: { start: BoxPoint; current: BoxPoint; additive: boolean } | null = null;
  private boxSelectProjector: ((world: THREE.Vector3) => BoxPoint | null) | null = null;

  constructor(private readonly getVolumes: () => readonly GLVolume[]) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get gizmo(): OpenGizmo { return this.openGizmo; }
  get scaleSpace(): ScaleSpace { return this.scaleSpaceState; }
  get owner(): PointerOwner { return this.pointerOwner; }
  /** Distinct selected instances — the panels' multi-selection display rule. */
  get selectionInstanceCount(): number {
    return this.selection.instanceKeys(this.getVolumes()).size;
  }

  /**
   * Toggle a gizmo on/off — the toolbar is its only opener, and it can only
   * arm while something is selected (an empty selection makes the toggle a
   * no-op). Toggling another mode while one is armed switches modes.
   * Selection never auto-opens a gizmo; an emptied selection auto-closes the
   * armed one.
   */
  toggleGizmo(mode: Exclude<OpenGizmo, null>): boolean {
    if (this.selection.empty) return false;
    this.openGizmo = this.openGizmo === mode ? null : mode;
    this.emit();
    return this.openGizmo === mode;
  }

  /**
   * World/local handle space for the scale gizmo. Local requires exactly one
   * selected instance (a group has no single orientation); the panel disables
   * the toggle and the setter refuses local while multi-selected.
   */
  setScaleSpace(space: ScaleSpace): boolean {
    if (space === 'local' && this.selection.instanceKeys(this.getVolumes()).size > 1) return false;
    if (this.scaleSpaceState === space) return false;
    this.scaleSpaceState = space;
    this.emit();
    return true;
  }

  /** The scene's gizmo pivot group; TransformControls manipulates it. */
  attachPivot(pivot: THREE.Object3D | null): void {
    this.pivot = pivot;
  }

  /**
   * World orientation of the single selected instance (instance ZYX × volume
   * ZYX), or null for a group or empty selection — the local scale handles
   * align to it.
   */
  selectionOrientation(): THREE.Quaternion | null {
    if (this.selection.instanceKeys(this.getVolumes()).size !== 1) return null;
    const volumes = this.selectedVolumes();
    if (volumes.length === 0) return null;
    return new THREE.Quaternion().multiplyQuaternions(
      quatFromRotation(volumes[0].instanceTransform.rotation),
      quatFromRotation(volumes[0].volumeTransform.rotation),
    );
  }
  get pointerStartsOnGizmo(): boolean { return this.pointerOrigin === 'gizmo'; }
  get activeDrag(): DragSnapshot | null { return this.drag; }
  get bodyDragEnabled(): boolean {
    // The initiating DragControls must stay enabled for the rest of its own
    // gesture. A gizmo remains exclusive; other body wrappers are still
    // blocked synchronously by tryBeginBodyDrag/update ownership checks.
    return (this.pointerOrigin === 'non-gizmo' || !this.gizmoGrabberHovered)
      && (this.pointerOwner === 'none' || this.pointerOwner === 'body')
      // An unselected body must be able to start the same press that selects
      // it. GLVolumeMesh selects synchronously at pointer-down, before
      // DragControls crosses its movement threshold.
      && this.pointerOrigin !== 'gizmo';
  }

  selectedVolumes(): GLVolume[] {
    return this.selection.volumes(this.getVolumes());
  }

  /** Unique object indices behind the current selection, sorted ascending.
   *  Deleting removes the complete objects that own the selected instances. */
  selectedObjectIndices(): number[] {
    const indices = new Set<number>();
    for (const volume of this.selectedVolumes()) indices.add(volume.buffer.objectIdx);
    return [...indices].sort((a, b) => a - b);
  }

  selectFromHit(hit: GLVolume, additive: boolean): boolean {
    const changed = additive
      ? this.selection.toggleFromHit(hit, this.getVolumes())
      : this.selection.replaceFromHit(hit, this.getVolumes());
    this.syncGizmoToSelection();
    if (changed) this.emit();
    return changed;
  }

  /**
   * Prepare a body press before DragControls begins its thresholded gesture.
   * A gizmo-origin press retains strict priority even if its ray also reaches
   * a model mesh.
   */
  prepareBodyDragFromPointerDown(hit: GLVolume, additive: boolean): boolean {
    if (this.pointerOrigin === 'gizmo' || this.pointerOwner !== 'none') return false;
    // A drag that starts on a member of an existing multi-selection must move
    // the complete group. Leave selection unchanged while DragControls
    // decides whether this press turns into a drag.
    if (!additive && this.selection.has(hit)) return false;
    return this.selectFromHit(hit, additive);
  }

  /** Preserve a multi-selection when the browser dispatches click after drag end. */
  selectFromClick(hit: GLVolume, additive: boolean): boolean {
    if (this.suppressPostDragClick) {
      this.suppressPostDragClick = false;
      return false;
    }
    // Plain clicks on an existing member keep the complete selection. Ctrl or
    // Cmd remains the explicit gesture for toggling a selected member.
    if (!additive && this.selection.has(hit)) return false;
    return this.selectFromHit(hit, additive);
  }

  clearSelection(): boolean {
    const selectionChanged = this.selection.clear();
    this.cancelDrag();
    const boxAbandoned = this.abandonBoxSelect();
    this.openGizmo = null;
    if (selectionChanged || boxAbandoned) this.emit();
    return selectionChanged || boxAbandoned;
  }

  /** The live marquee rect (normalized, viewport CSS pixels) while box-selecting. */
  get boxSelectionRect(): BoxRect | null {
    return this.boxSelect ? normalizeRect(this.boxSelect.start, this.boxSelect.current) : null;
  }

  /** Register the viewport's world→screen projector; without one, end is a no-op. */
  registerBoxSelectProjector(projector: ((world: THREE.Vector3) => BoxPoint | null) | null): void {
    this.boxSelectProjector = projector;
  }

  /**
   * Claim a Shift+drag press for box selection. Gizmo presses keep priority
   * (a handle grab is never hijacked by the marquee), and a busy pointer
   * (body/gizmo/box gesture) is never preempted.
   */
  beginBoxSelect(start: BoxPoint, additive: boolean): boolean {
    if (this.pointerOrigin === 'gizmo' || this.pointerOwner !== 'none') return false;
    this.pointerOwner = 'box';
    this.boxSelect = { start, current: { ...start }, additive };
    this.emit();
    return true;
  }

  /** Track the marquee's current corner during an active box gesture. */
  updateBoxSelect(current: BoxPoint): boolean {
    if (!this.boxSelect || this.pointerOwner !== 'box') return false;
    this.boxSelect = { ...this.boxSelect, current: { ...current } };
    this.emit();
    return true;
  }

  /**
   * Finish the gesture and apply the marquee selection — replace by default,
   * union when the Shift press carried Ctrl/Cmd.
   */
  endBoxSelect(): boolean {
    if (!this.boxSelect || this.pointerOwner !== 'box') return false;
    const box = this.boxSelect;
    const changed = this.applyBoxSelection(box.start, box.current, box.additive);
    this.abandonBoxSelect();
    this.syncGizmoToSelection();
    this.emit();
    return changed;
  }

  /** Drop an active marquee without selecting anything (cancel/Escape). */
  cancelBoxSelect(): boolean {
    const changed = this.abandonBoxSelect();
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
    const hadState = !this.selection.empty || this.openGizmo !== null || this.drag !== null
      || this.pointerOwner !== 'none' || this.boxSelect !== null;
    this.selection.clear();
    this.openGizmo = null;
    this.drag = null;
    this.suppressPostDragClick = false;
    this.pointerOwner = 'none';
    this.pointerOrigin = 'none';
    this.gizmoGrabberHovered = false;
    this.boxSelect = null;
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

  /** Apply a world-space pivot position during a body gesture (translate). */
  updateDragPivot(nextPivot: THREE.Vector3): boolean {
    if (!this.drag) return false;
    const delta = nextPivot.clone().sub(this.drag.startPivot);
    this.applySnapshotDelta(this.drag.startInstances, delta);
    this.emit();
    return true;
  }

  /**
   * Apply the gizmo target's full transform during an active gizmo gesture.
   * The delta is always relative to the gesture's captured start, so the
   * pivot needs no pre-drag reset for correctness (the scene resets it
   * between gestures for clean gizmo rendering).
   */
  updateGizmoTransform(next: {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    scale: THREE.Vector3;
  }): boolean {
    const drag = this.drag;
    if (!drag || drag.kind !== 'gizmo') return false;
    if (this.openGizmo === 'rotate') {
      const deltaQuat = next.quaternion.clone().multiply(drag.startQuaternion.clone().invert());
      this.applyRotationDeltaToSnapshot(drag.startInstances, drag.startPivot, deltaQuat);
    } else if (this.openGizmo === 'scale') {
      const factor: Vec3 = [
        safeRatio(next.scale.x, drag.startScale.x),
        safeRatio(next.scale.y, drag.startScale.y),
        safeRatio(next.scale.z, drag.startScale.z),
      ];
      // The pivot's start orientation is the scale space: identity for world,
      // the selection orientation for local.
      this.applyScaleDeltaToSnapshot(drag.startInstances, drag.startPivot, factor, drag.startQuaternion);
    } else {
      const delta = next.position.clone().sub(drag.startPivot);
      this.applySnapshotDelta(drag.startInstances, delta);
    }
    this.emit();
    return true;
  }

  endDrag(): boolean {
    if (!this.drag) return false;
    this.drag = null;
    this.pointerOwner = 'none';
    this.pointerOrigin = 'none';
    this.gizmoGrabberHovered = false;
    // DragControls and TransformControls can both leave a model-targeted
    // click behind after mouseup. It is part of the completed gesture, not a
    // new selection request, even when the cursor ends over one group member.
    this.suppressPostDragClick = true;
    this.emit();
    return true;
  }

  cancelDrag(): boolean {
    if (!this.drag) {
      // An active box gesture owns the pointer; clearSelection abandons it
      // explicitly instead of letting this drag-less reset clobber it.
      if (this.pointerOwner === 'none') {
        this.pointerOrigin = 'none';
        this.gizmoGrabberHovered = false;
      }
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
    if (this.selection.empty) return false;
    const minZ = this.exactWorldMinZ();
    if (!Number.isFinite(minZ)) return false;
    // Drop uses the TRUE world min-Z over the actual transformed vertices,
    // not the selection's loose AABB. The AABB of a rotated local bbox
    // over-approximates the model (it extends below the low point), so
    // dropping to it would leave an arbitrarily-rotated model floating above
    // the plate.
    return this.moveSelectionBy(new THREE.Vector3(0, 0, -minZ));
  }

  /** Rotate every selected instance by a componentwise Euler delta (radians). */
  rotateSelectionBy(delta: Vec3): boolean {
    if (this.selection.empty) return false;
    const next = new Map<InstanceKey, ModelTransform>();
    for (const [key, transform] of this.captureSelectedInstances()) {
      const rotated = cloneTransform(transform);
      rotated.rotation = [
        transform.rotation[0] + delta[0],
        transform.rotation[1] + delta[1],
        transform.rotation[2] + delta[2],
      ];
      next.set(key, rotated);
    }
    this.applyInstanceTransforms(next);
    this.emit();
    return true;
  }

  /** Multiply every selected instance's scale by `factor` (clamped > 0). */
  scaleSelectionBy(factor: Vec3): boolean {
    if (this.selection.empty) return false;
    const pivot = this.selectionPivot();
    if (!pivot) return false;
    // Rigidly scale the whole selection about the aggregate pivot (offsets
    // displace too), so the selection stays visually centered while its size
    // changes — the same semantics as the size edit and the gizmo drag.
    this.applyScaleDeltaToSnapshot(this.captureSelectedInstances(), pivot, factor, new THREE.Quaternion());
    this.emit();
    return true;
  }

  /** Scale the selection so its bounding-box `axis` size becomes `size` mm. */
  scaleSelectionToSize(axis: 0 | 1 | 2, size: number): boolean {
    if (this.selection.empty || size <= 0) return false;
    const bounds = this.selectionBounds();
    if (!bounds) return false;
    const current = bounds.getSize(new THREE.Vector3()).getComponent(axis);
    if (current <= 1e-9) return false;
    const factor = [1, 1, 1] as Vec3;
    factor[axis] = size / current;
    return this.scaleSelectionBy(factor);
  }

  /** Restore the load-time rotation of every selected instance. */
  resetSelectionRotation(): boolean {
    return this.restoreSelectionProperty('rotation');
  }

  /** Restore the load-time scale of every selected instance. */
  resetSelectionScale(): boolean {
    return this.restoreSelectionProperty('scale');
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

  private beginDrag(kind: 'gizmo' | 'body'): boolean {
    const pivot = this.selectionPivot();
    if (!pivot) return false;
    this.pointerOwner = kind;
    this.drag = {
      kind,
      startPivot: pivot,
      startQuaternion: this.pivot?.quaternion.clone() ?? new THREE.Quaternion(),
      startScale: this.pivot?.scale.clone() ?? new THREE.Vector3(1, 1, 1),
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

  private applyBoxSelection(start: BoxPoint, current: BoxPoint, additive: boolean): boolean {
    const rect = normalizeRect(start, current);
    const projector = this.boxSelectProjector;
    if (!projector) return false;
    const perInstance = new Map<InstanceKey, BoxRect>();
    for (const volume of this.getVolumes()) {
      const projected = this.projectVolumeRect(volume, projector);
      if (!projected) continue;
      const key = instanceKeyOf(volume);
      const existing = perInstance.get(key);
      perInstance.set(key, existing ? unionRects(existing, projected) : projected);
    }
    const ids: string[] = [];
    for (const volume of this.getVolumes()) {
      const bounds = perInstance.get(instanceKeyOf(volume));
      if (bounds && rectsOverlap(rect, bounds)) ids.push(volume.id);
    }
    return additive ? this.selection.addIds(ids) : this.selection.replaceIds(ids);
  }

  /** Project a volume's world AABB into a viewport rect (corners behind the
   *  camera are skipped; fully-behind volumes contribute nothing). */
  private projectVolumeRect(
    volume: GLVolume,
    projector: (world: THREE.Vector3) => BoxPoint | null,
  ): BoxRect | null {
    const bounds = worldBounds(volume);
    const corner = new THREE.Vector3();
    let projectedAny = false;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 8; i++) {
      corner.set(
        i & 1 ? bounds.max.x : bounds.min.x,
        i & 2 ? bounds.max.y : bounds.min.y,
        i & 4 ? bounds.max.z : bounds.min.z,
      );
      const point = projector(corner);
      if (!point) continue;
      projectedAny = true;
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    if (!projectedAny) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  private abandonBoxSelect(): boolean {
    if (!this.boxSelect) return false;
    this.boxSelect = null;
    this.pointerOwner = 'none';
    this.pointerOrigin = 'none';
    this.gizmoGrabberHovered = false;
    return true;
  }

  private applySnapshotDelta(snapshot: ReadonlyMap<InstanceKey, ModelTransform>, delta: THREE.Vector3): void {
    const next = new Map<InstanceKey, ModelTransform>();
    for (const [key, transform] of snapshot) {
      if (transform.matrix) {
        const m = matrixFromTransform(transform);
        m.elements[12] += delta.x;
        m.elements[13] += delta.y;
        m.elements[14] += delta.z;
        next.set(key, normalizeTransform({ ...transformFromMatrix(m, transform) }));
        continue;
      }
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

  private applyRotationDeltaToSnapshot(
    snapshot: ReadonlyMap<InstanceKey, ModelTransform>,
    pivot: THREE.Vector3,
    deltaQuat: THREE.Quaternion,
  ): void {
    const next = new Map<InstanceKey, ModelTransform>();
    for (const [key, transform] of snapshot) {
      next.set(key, applyRotationDelta(transform, deltaQuat, pivot));
    }
    this.applyInstanceTransforms(next);
  }

  private applyScaleDeltaToSnapshot(
    snapshot: ReadonlyMap<InstanceKey, ModelTransform>,
    pivot: THREE.Vector3,
    factor: Vec3,
    spaceQuat: THREE.Quaternion,
  ): void {
    const next = new Map<InstanceKey, ModelTransform>();
    for (const [key, transform] of snapshot) {
      next.set(key, applyScaleDelta(transform, factor, pivot, spaceQuat));
    }
    this.applyInstanceTransforms(next);
  }

  private restoreSelectionProperty(property: 'rotation' | 'scale'): boolean {
    const selected = this.selectedVolumes();
    if (selected.length === 0) return false;
    const next = new Map<InstanceKey, ModelTransform>();
    for (const volume of selected) {
      const key = instanceKeyOf(volume);
      if (next.has(key)) continue;
      const transform = cloneTransform(volume.instanceTransform);
      transform[property] = [...volume.buffer.instanceTransform[property]] as Vec3;
      // A sheared transform's `matrix` is authoritative — a per-property reset
      // must drop it, else the reset is silently ignored.
      if (transform.matrix) delete transform.matrix;
      next.set(key, transform);
    }
    this.applyInstanceTransforms(next);
    this.emit();
    return true;
  }

  /** True world min-Z over the actual vertices of every selected instance. */
  private exactWorldMinZ(): number {
    let minZ = Infinity;
    const vertex = new THREE.Vector3();
    for (const volume of this.selectedVolumes()) {
      const matrix = transformMatrix(volume.instanceTransform).multiply(transformMatrix(volume.volumeTransform));
      const position = volume.geometry.getAttribute('position');
      for (let i = 0; i < position.count; i++) {
        vertex.fromBufferAttribute(position, i).applyMatrix4(matrix);
        if (vertex.z < minZ) minZ = vertex.z;
      }
    }
    return minZ;
  }

  private applyInstanceTransforms(transforms: ReadonlyMap<InstanceKey, ModelTransform>): void {
    for (const volume of this.getVolumes()) {
      const transform = transforms.get(instanceKeyOf(volume));
      if (transform) volume.instanceTransform = cloneTransform(transform);
    }
  }

  // Gizmos never auto-open on selection; a selection that empties (e.g. a
  // model reload pruning stale IDs) auto-closes the armed gizmo.
  private syncGizmoToSelection(): void {
    if (this.selection.empty) this.openGizmo = null;
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
  return matrixFromTransform(transform);
}

function safeRatio(current: number, start: number): number {
  return start === 0 ? 1 : current / start;
}

function cloneTransform(transform: ModelTransform): ModelTransform {
  return {
    offset: [...transform.offset] as Vec3,
    rotation: [...transform.rotation] as Vec3,
    scale: [...transform.scale] as Vec3,
    mirror: [...transform.mirror] as Vec3,
    ...(transform.matrix ? { matrix: [...transform.matrix] as ModelTransform['matrix'] } : {}),
  };
}
