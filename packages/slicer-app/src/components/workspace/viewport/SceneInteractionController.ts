import * as THREE from 'three';
import type { ModelTransform } from '@slicer/client';
import type { Vec3 } from '../../../lib/vec3';
import { GLVolume } from './GLVolume';
import { instanceKeyOf, Selection, type InstanceKey, type SelectionMode } from './Selection';
import {
  applyRotationDelta,
  applyScaleDelta,
  clampScale,
  matrixFromTransform,
  normalizeTransform,
  quatFromRotation,
  rotateMatrixAroundPivot,
  scaleMatrixAroundPivot,
  transformFromMatrix,
  translateMatrix,
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
/** OrcaSlicer's homogeneous selection classes (Selection.cpp update_type). */
export type SelectionKind = 'empty' | 'object' | 'instance' | 'part' | 'mixed';

/** How a drag/gizmo edit is applied: to the instance transform (whole instance)
 *  or to the volume transform of specific parts (part-scoped selection). */
export type DragTargetEntry =
  | { kind: 'instance'; instanceKey: InstanceKey; transform: ModelTransform }
  | { kind: 'volume'; volume: GLVolume; volumeTransform: ModelTransform; instanceTransform: ModelTransform };

export interface DragSnapshot {
  readonly kind: 'gizmo' | 'body';
  readonly startPivot: THREE.Vector3;
  readonly startQuaternion: THREE.Quaternion;
  readonly startScale: THREE.Vector3;
  readonly startTargets: DragTargetEntry[];
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
  private selectionModeState: SelectionMode = 'instance';
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
  get selectionMode(): SelectionMode { return this.selectionModeState; }
  /** Distinct selected instances — the panels' multi-selection display rule. */
  get selectionInstanceCount(): number {
    return this.selection.instanceKeys(this.getVolumes()).size;
  }

  /** Set how a canvas click expands selection (object / volume / instance). */
  setSelectionMode(mode: SelectionMode): boolean {
    if (this.selectionModeState === mode) return false;
    this.selectionModeState = mode;
    this.emit();
    return true;
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

  /** Close the armed gizmo without changing the shared selection. */
  closeGizmo(): boolean {
    if (this.openGizmo === null) return false;
    this.openGizmo = null;
    this.emit();
    return true;
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

  /** True when the selection is part-scoped: some instance has only a subset of
   *  its volumes selected. This makes drag/gizmo edits apply to the VOLUME
   *  transforms (moving only the selected parts), not the instance transform. */
  isVolumeScopedSelection(): boolean {
    const selected = this.selectedVolumes();
    if (selected.length === 0) return false;
    const per = new Map<string, { sel: number; total: number }>();
    for (const volume of this.getVolumes()) {
      const key = `${volume.buffer.objectIdx}:${volume.buffer.instanceIdx}`;
      const rec = per.get(key) ?? { sel: 0, total: 0 };
      rec.total += 1;
      if (this.selection.has(volume)) rec.sel += 1;
      per.set(key, rec);
    }
    for (const rec of per.values()) if (rec.sel > 0 && rec.sel < rec.total) return true;
    return false;
  }

  /** The single instance of `objectIdx` the current selection is focused on, or 0
   *  when the selection is empty or spans multiple instances. This anchors a
   *  ObjectList part-row selection to one instance (Orca's `get_instance_idx()`
   *  behaviour for part selections). */
  getSelectionInstanceAnchor(objectIdx: number): number {
    const selected = this.selectedVolumes();
    if (selected.length === 0) return 0;
    const instance = selected[0].buffer.instanceIdx;
    for (const volume of selected)
      if (volume.buffer.objectIdx !== objectIdx || volume.buffer.instanceIdx !== instance) return 0;
    return instance;
  }

  /** Classify the current selection as Orca does (Selection.cpp update_type):
   *  whole object(s) -> 'object', whole instance(s) of one object -> 'instance',
   *  a partial set of one instance -> 'part', anything else -> 'mixed'
   *  (invalid for edits). */
  computeSelectionKind(): SelectionKind {
    return this.classifyVolumeIds(this.selectedVolumes().map((volume) => volume.id));
  }

  /** Classify an arbitrary set of GLVolume IDs by MODE against the live volume
   *  collection. Shared by the viewport and the ObjectList so the homogeneity
   *  rule is enforced uniformly. An instance is a full object at the instance
   *  level, so a full instance and a full object live in `Instance` mode and may
   *  be mixed. Only a part (`Volume` mode) is restricted: it is anchored to a
   *  single instance, and mixing it with an instance/object, or spanning several
   *  instances, is Orca's `Mixed` (invalid for edits). Modifiers / SLA helpers /
   *  the wipe tower are not special-cased here (the ObjectList treats them as
   *  ordinary volumes). */
  classifyVolumeIds(ids: readonly string[]): SelectionKind {
    const selectedSet = new Set(ids.filter((id) => id !== ''));
    if (selectedSet.size === 0) return 'empty';

    const perInstance = new Map<string, number>(); // total volumes per (obj, inst)
    for (const volume of this.getVolumes()) {
      const key = `${volume.buffer.objectIdx}:${volume.buffer.instanceIdx}`;
      perInstance.set(key, (perInstance.get(key) ?? 0) + 1);
    }

    const touched = new Map<string, number>(); // selected count per (obj, inst)
    const touchedObjects = new Set<number>();
    for (const id of selectedSet) {
      const [oiStr, , iiStr] = id.split(':');
      const key = `${oiStr}:${iiStr}`;
      touched.set(key, (touched.get(key) ?? 0) + 1);
      touchedObjects.add(Number(oiStr));
    }

    // Mode homogeneity: a partial instance is the only thing that can be part-
    // scoped. It is valid only as a lone part set (one object, one instance).
    const hasPartial = [...touched].some(([key, sel]) => sel < (perInstance.get(key) ?? sel));
    if (hasPartial)
      return touchedObjects.size === 1 && touched.size === 1 ? 'part' : 'mixed';

    // No partial instance -> everything is a whole instance (an instance is a
    // full object at that level), so full instances and full objects may mix.
    if (touchedObjects.size > 1) return 'object';
    const objectIdx = [...touchedObjects][0];
    const totalInstances = [...perInstance.keys()].filter((key) => Number(key.split(':')[0]) === objectIdx);
    return touched.size === totalInstances.length ? 'object' : 'instance';
  }

  /** Whether applying `addIds`/`removeIds` to the current selection keeps it
   *  homogeneous (Orca's `Mixed` is invalid for edits). */
  wouldSelectionChangeBeMixed(addIds: readonly string[], removeIds: readonly string[]): boolean {
    const next = new Set(this.selectedVolumes().map((volume) => volume.id));
    removeIds.forEach((id) => next.delete(id));
    addIds.forEach((id) => next.add(id));
    return this.classifyVolumeIds([...next]) === 'mixed';
  }

  /** Whether toggling these volume IDs (add if not selected, remove if selected)
   *  keeps the selection homogeneous. */
  canToggleVolumeIds(ids: readonly string[]): boolean {
    const current = new Set(this.selectedVolumes().map((volume) => volume.id));
    const allIn = ids.every((id) => current.has(id));
    return !this.wouldSelectionChangeBeMixed(allIn ? [] : ids, allIn ? ids : []);
  }

  /** Whether adding these volume IDs to the selection keeps it homogeneous. */
  canAddVolumeIds(ids: readonly string[]): boolean {
    return !this.wouldSelectionChangeBeMixed(ids, []);
  }

  /** The GLVolume IDs a click expands to for a given selection mode (Orca's
   *  part selection is anchored to the clicked instance). */
  private hitModeVolumeIds(hit: GLVolume, mode: SelectionMode): string[] {
    if (mode === 'object') return this.getVolumes().filter((v) => v.buffer.objectIdx === hit.buffer.objectIdx).map((v) => v.id);
    if (mode === 'volume')
      return this.getVolumes().filter(
        (v) => v.buffer.objectIdx === hit.buffer.objectIdx
          && v.buffer.volumeIdx === hit.buffer.volumeIdx
          && v.buffer.instanceIdx === hit.buffer.instanceIdx,
      ).map((v) => v.id);
    const key = instanceKeyOf(hit);
    return this.getVolumes().filter((v) => instanceKeyOf(v) === key).map((v) => v.id);
  }

  /** The GLVolume IDs a composite target selects (object, part, or instance). */
  private compositeVolumeIds(objectIdx: number, volumeIdx?: number, instanceIdx?: number): string[] {
    if (volumeIdx !== undefined) {
      const instIdx = instanceIdx ?? 0;
      return this.getVolumes().filter(
        (v) => v.buffer.objectIdx === objectIdx && v.buffer.volumeIdx === volumeIdx && v.buffer.instanceIdx === instIdx,
      ).map((v) => v.id);
    }
    if (instanceIdx !== undefined)
      return this.getVolumes().filter((v) => v.buffer.objectIdx === objectIdx && v.buffer.instanceIdx === instanceIdx).map((v) => v.id);
    return this.getVolumes().filter((v) => v.buffer.objectIdx === objectIdx).map((v) => v.id);
  }

  selectFromHit(hit: GLVolume, additive: boolean, part = false): boolean {
    // Alt modifies the click to select the individual part (volume), not the
    // whole instance — the workspace's per-click override of the selection mode.
    const mode = part ? 'volume' : this.selectionMode;
    if (additive && !this.canToggleVolumeIds(this.hitModeVolumeIds(hit, mode))) return false;
    const changed = additive
      ? this.selection.toggleFromHit(hit, this.getVolumes(), mode)
      : this.selection.replaceFromHit(hit, this.getVolumes(), mode);
    this.syncGizmoToSelection();
    if (changed) this.emit();
    return changed;
  }

  /**
   * Select the volumes matching a composite target (object list row click).
   * The caller passes current object/volume/instance indices (resolved from
   * stable ObjectIDs by the list/spec §7 as needed).
   */
  selectComposite(objectIdx: number, volumeIdx?: number, instanceIdx?: number, additive = false): boolean {
    if (additive && !this.canToggleVolumeIds(this.compositeVolumeIds(objectIdx, volumeIdx, instanceIdx))) return false;
    const changed = additive
      ? this.selection.toggleComposite(this.getVolumes(), { objectIdx, volumeIdx, instanceIdx })
      : this.selection.replaceComposite(this.getVolumes(), { objectIdx, volumeIdx, instanceIdx });
    this.syncGizmoToSelection();
    if (changed) this.emit();
    return changed;
  }

  /** Replace (or, when additive, union) the selection with raw volume IDs
   *  (used by the ObjectList's Shift-range multi-select). */
  selectVolumeIds(ids: readonly string[], additive = false): boolean {
    if (additive && !this.canAddVolumeIds(ids)) return false;
    const changed = additive ? this.selection.addIds(ids) : this.selection.replaceIds(ids);
    this.syncGizmoToSelection();
    if (changed) this.emit();
    return changed;
  }

  /**
   * Prepare a body press before DragControls begins its thresholded gesture.
   * A gizmo-origin press retains strict priority even if its ray also reaches
   * a model mesh.
   */
  prepareBodyDragFromPointerDown(hit: GLVolume, additive: boolean, part = false): boolean {
    if (this.pointerOrigin === 'gizmo' || this.pointerOwner !== 'none') return false;
    // A drag that starts on a member of an existing multi-selection must move
    // the complete group. Leave selection unchanged while DragControls
    // decides whether this press turns into a drag.
    if (!additive && !part && this.selection.has(hit)) return false;
    return this.selectFromHit(hit, additive, part);
  }

  /** Preserve a multi-selection when the browser dispatches click after drag end. */
  selectFromClick(hit: GLVolume, additive: boolean, part = false): boolean {
    if (this.suppressPostDragClick) {
      this.suppressPostDragClick = false;
      return false;
    }
    // Plain clicks on an existing member keep the complete selection. Ctrl or
    // Cmd remains the explicit gesture for toggling a selected member; Alt
    // explicitly narrows to the part.
    if (!additive && !part && this.selection.has(hit)) return false;
    return this.selectFromHit(hit, additive, part);
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
    this.applySnapshotDelta(this.drag.startTargets, delta);
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
      this.applyRotationDeltaToSnapshot(drag.startTargets, drag.startPivot, deltaQuat);
    } else if (this.openGizmo === 'scale') {
      const factor: Vec3 = [
        safeRatio(next.scale.x, drag.startScale.x),
        safeRatio(next.scale.y, drag.startScale.y),
        safeRatio(next.scale.z, drag.startScale.z),
      ];
      // The pivot's start orientation is the scale space: identity for world,
      // the selection orientation for local.
      this.applyScaleDeltaToSnapshot(drag.startTargets, drag.startPivot, factor, drag.startQuaternion);
    } else {
      const delta = next.position.clone().sub(drag.startPivot);
      this.applySnapshotDelta(drag.startTargets, delta);
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
    this.applySnapshotDelta(this.drag.startTargets, new THREE.Vector3());
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
    this.applySnapshotDelta(this.captureDragTargets(), delta);
    this.emit();
    return true;
  }

  dropSelectionToBed(): boolean {
    if (this.selection.empty) return false;
    const minZ = this.exactWorldMinZ();
    if (!Number.isFinite(minZ)) return false;
    // Drop uses the TRUE world min-Z over the actual transformed vertices. It
    // is computed directly rather than via selectionBounds() so the single
    // scalar we need never builds the whole aggregate AABB. Both now agree
    // because the selection AABB is tight to those same vertices (see
    // GLVolume.getWorldBounds).
    return this.moveSelectionBy(new THREE.Vector3(0, 0, -minZ));
  }

  /** Rotate every selected instance by a componentwise Euler delta (radians). */
  rotateSelectionBy(delta: Vec3): boolean {
    if (this.selection.empty) return false;
    const next = this.captureDragTargets().map((entry) => {
      if (entry.kind === 'instance') {
        const rotated = cloneTransform(entry.transform);
        rotated.rotation = [
          entry.transform.rotation[0] + delta[0],
          entry.transform.rotation[1] + delta[1],
          entry.transform.rotation[2] + delta[2],
        ];
        return { ...entry, transform: rotated };
      }
      const instance = matrixFromTransform(entry.instanceTransform);
      // Apply the rotation as a world delta about the selection pivot, then solve
      // the volume back out so only the selected part rotates.
      const world = instance.clone().multiply(matrixFromTransform(entry.volumeTransform));
      const pivot = this.selectionPivot() ?? new THREE.Vector3();
      const newWorld = rotateMatrixAroundPivot(world, quatFromRotation(delta), pivot);
      return { ...entry, volumeTransform: transformFromMatrix(instance.clone().invert().multiply(newWorld), entry.volumeTransform) };
    });
    this.applyTargetTransforms(next);
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
    this.applyScaleDeltaToSnapshot(this.captureDragTargets(), pivot, factor, new THREE.Quaternion());
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
    const next = this.captureDragTargets().map((entry) => {
      if (entry.kind === 'instance') {
        const volume = this.getVolumes().find((v) => instanceKeyOf(v) === entry.instanceKey);
        return { ...entry, transform: volume ? cloneTransform(volume.buffer.instanceTransform) : entry.transform };
      }
      return { ...entry, volumeTransform: cloneTransform(entry.volume.buffer.volumeTransform) };
    });
    this.applyTargetTransforms(next);
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
      startTargets: this.captureDragTargets(),
    };
    this.emit();
    return true;
  }

  /**
   * Capture the transforms to edit for the current selection. A part-scoped
   * selection edits the volume transforms (only the selected parts move); an
   * instance/object selection edits the instance transforms (whole instances
   * move). This is the single place that decides the edit scope.
   */
  private captureDragTargets(): DragTargetEntry[] {
    if (this.isVolumeScopedSelection()) {
      return this.selectedVolumes().map((volume) => ({
        kind: 'volume',
        volume,
        volumeTransform: cloneTransform(volume.volumeTransform),
        instanceTransform: cloneTransform(volume.instanceTransform),
      }));
    }
    const seen = new Set<InstanceKey>();
    const entries: DragTargetEntry[] = [];
    for (const volume of this.selectedVolumes()) {
      const key = instanceKeyOf(volume);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'instance', instanceKey: key, transform: cloneTransform(volume.instanceTransform) });
    }
    return entries;
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
    if (additive && !this.canAddVolumeIds(ids)) return false;
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

  private applySnapshotDelta(snapshot: DragTargetEntry[], delta: THREE.Vector3): void {
    const next = snapshot.map((entry) => {
      if (entry.kind === 'instance') {
        const transform = entry.transform;
        if (transform.matrix) {
          const m = matrixFromTransform(transform);
          m.elements[12] += delta.x;
          m.elements[13] += delta.y;
          m.elements[14] += delta.z;
          return { ...entry, transform: normalizeTransform({ ...transformFromMatrix(m, transform) }) };
        }
        const moved = cloneTransform(transform);
        moved.offset = [
          transform.offset[0] + delta.x,
          transform.offset[1] + delta.y,
          transform.offset[2] + delta.z,
        ];
        return { ...entry, transform: moved };
      }
      const volume = this.solveVolumeWorldDelta(entry, (world) => translateMatrix(world, delta));
      return { ...entry, volumeTransform: volume };
    });
    this.applyTargetTransforms(next);
  }

  private applyRotationDeltaToSnapshot(
    snapshot: DragTargetEntry[],
    pivot: THREE.Vector3,
    deltaQuat: THREE.Quaternion,
  ): void {
    const next = snapshot.map((entry) => {
      if (entry.kind === 'instance') return { ...entry, transform: applyRotationDelta(entry.transform, deltaQuat, pivot) };
      const volume = this.solveVolumeWorldDelta(entry, (world) => rotateMatrixAroundPivot(world, deltaQuat, pivot));
      return { ...entry, volumeTransform: volume };
    });
    this.applyTargetTransforms(next);
  }

  private applyScaleDeltaToSnapshot(
    snapshot: DragTargetEntry[],
    pivot: THREE.Vector3,
    factor: Vec3,
    spaceQuat: THREE.Quaternion,
  ): void {
    const next = snapshot.map((entry) => {
      if (entry.kind === 'instance') return { ...entry, transform: applyScaleDelta(entry.transform, factor, pivot, spaceQuat) };
      const out = this.solveVolumeWorldDelta(entry, (world) => scaleMatrixAroundPivot(world, factor, pivot, spaceQuat));
      return { ...entry, volumeTransform: { ...out, scale: out.scale.map((s) => clampScale(Math.abs(s))) as Vec3 } };
    });
    this.applyTargetTransforms(next);
  }

  private restoreSelectionProperty(property: 'rotation' | 'scale'): boolean {
    const selected = this.selectedVolumes();
    if (selected.length === 0) return false;
    const next = this.captureDragTargets().map((entry) => {
      if (entry.kind === 'instance') {
        const volume = this.getVolumes().find((v) => instanceKeyOf(v) === entry.instanceKey);
        const transform = cloneTransform(entry.transform);
        if (volume) transform[property] = [...volume.buffer.instanceTransform[property]] as Vec3;
        // A sheared transform's `matrix` is authoritative — a per-property reset
        // must drop it, else the reset is silently ignored.
        if (transform.matrix) delete transform.matrix;
        return { ...entry, transform };
      }
      const transform = cloneTransform(entry.volumeTransform);
      transform[property] = [...entry.volume.buffer.volumeTransform[property]] as Vec3;
      if (transform.matrix) delete transform.matrix;
      return { ...entry, volumeTransform: transform };
    });
    this.applyTargetTransforms(next);
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

  /** Solve a part-scoped (volume) edit: apply a world-space delta to the volume's
   *  world matrix (instance·volume) and back the volume transform out, leaving the
   *  instance transform untouched. */
  private solveVolumeWorldDelta(
    entry: Extract<DragTargetEntry, { kind: 'volume' }>,
    worldApply: (world: THREE.Matrix4) => THREE.Matrix4,
  ): ModelTransform {
    const instance = matrixFromTransform(entry.instanceTransform);
    const world = instance.clone().multiply(matrixFromTransform(entry.volumeTransform));
    const newWorld = worldApply(world);
    return transformFromMatrix(instance.clone().invert().multiply(newWorld), entry.volumeTransform);
  }

  private applyTargetTransforms(entries: DragTargetEntry[]): void {
    if (entries.length === 0) return;
    if (entries[0].kind === 'instance') {
      const instanceEntries = entries.filter(
        (entry): entry is Extract<DragTargetEntry, { kind: 'instance' }> => entry.kind === 'instance',
      );
      // Keep the native Orca invariant at the renderer boundary.  An object's
      // instances share the linear part of their instance transform (scale
      // and X/Y orientation), while their independent Z rotations remain
      // intact.  Capture the old transforms before applying the selected
      // targets: Orca's Selection::synchronize_unselected_instances applies
      // the relative linear change from the selected instance to every other
      // instance of the same object.
      const oldByInstance = new Map<InstanceKey, ModelTransform>();
      for (const volume of this.getVolumes()) {
        const key = instanceKeyOf(volume);
        if (!oldByInstance.has(key)) oldByInstance.set(key, cloneTransform(volume.instanceTransform));
      }

      for (const volume of this.getVolumes()) {
        for (const entry of instanceEntries) {
          if (entry.instanceKey === instanceKeyOf(volume)) volume.instanceTransform = cloneTransform(entry.transform);
        }
      }

      this.synchronizeInstanceLinearTransforms(instanceEntries, oldByInstance);
      this.synchronizeInstanceZPositions(instanceEntries);
    } else {
      // ModelVolume transforms are stored once per object volume in the native
      // model, while the renderer keeps one GLVolume for every instance copy.
      // Fan each edited volume transform out to every rendered copy so a later
      // sync cannot upload a stale sibling and overwrite the native value.
      const transformsByPart = new Map<string, ModelTransform>();
      for (const entry of entries) {
        if (entry.kind !== 'volume') continue;
        const key = `${entry.volume.buffer.objectIdx}:${entry.volume.buffer.volumeIdx}`;
        if (!transformsByPart.has(key)) transformsByPart.set(key, cloneTransform(entry.volumeTransform));
      }
      for (const volume of this.getVolumes()) {
        const key = `${volume.buffer.objectIdx}:${volume.buffer.volumeIdx}`;
        const transform = transformsByPart.get(key);
        if (transform) volume.volumeTransform = cloneTransform(transform);
      }
    }
  }

  /**
   * Port OrcaSlicer's Selection::synchronize_unselected_instances().  The
   * relative linear change is applied on the right of each other instance's
   * old linear matrix, which preserves its own Z-axis rotation while sharing
   * scale and the non-Z orientation.  A world-Z-only rotation intentionally
   * leaves unselected instances untouched.
   */
  private synchronizeInstanceLinearTransforms(
    entries: Extract<DragTargetEntry, { kind: 'instance' }>[],
    oldByInstance: ReadonlyMap<InstanceKey, ModelTransform>,
  ): void {
    const firstByObject = new Map<number, {
      key: InstanceKey;
      oldTransform: ModelTransform;
      nextTransform: ModelTransform;
    }>();
    const selectedKeys = new Set(entries.map((entry) => entry.instanceKey));

    for (const entry of entries) {
      const oldTransform = oldByInstance.get(entry.instanceKey);
      if (!oldTransform || firstByObject.has(this.objectIndex(entry.instanceKey))) continue;
      if (isWorldZOnlyRotation(oldTransform, entry.transform)) continue;
      firstByObject.set(this.objectIndex(entry.instanceKey), {
        key: entry.instanceKey,
        oldTransform,
        nextTransform: entry.transform,
      });
    }
    if (firstByObject.size === 0) return;

    const synchronized = new Map<InstanceKey, ModelTransform>();
    for (const volume of this.getVolumes()) {
      const objectIdx = volume.buffer.objectIdx;
      const source = firstByObject.get(objectIdx);
      const key = instanceKeyOf(volume);
      if (!source || selectedKeys.has(key) || synchronized.has(key)) continue;
      const oldTarget = oldByInstance.get(key);
      if (!oldTarget) continue;

      const sourceOldLinear = linearPart(matrixFromTransform(source.oldTransform));
      const sourceNextLinear = linearPart(matrixFromTransform(source.nextTransform));
      const relativeLinear = sourceOldLinear.clone().invert().multiply(sourceNextLinear);
      const targetMatrix = matrixFromTransform(oldTarget);
      const targetLinear = linearPart(targetMatrix).multiply(relativeLinear);
      targetLinear.setPosition(targetMatrix.elements[12], targetMatrix.elements[13], targetMatrix.elements[14]);
      synchronized.set(key, transformFromMatrix(targetLinear, oldTarget));
    }

    for (const volume of this.getVolumes()) {
      const transform = synchronized.get(instanceKeyOf(volume));
      if (transform) volume.instanceTransform = cloneTransform(transform);
    }
  }

  /** Every copy of an object stays on the source instance's Z plane. */
  private synchronizeInstanceZPositions(entries: Extract<DragTargetEntry, { kind: 'instance' }>[]): void {
    const zByObject = new Map<number, number>();
    for (const entry of entries) {
      const objectIdx = this.objectIndex(entry.instanceKey);
      if (!zByObject.has(objectIdx)) zByObject.set(objectIdx, matrixFromTransform(entry.transform).elements[14]);
    }
    for (const volume of this.getVolumes()) {
      const z = zByObject.get(volume.buffer.objectIdx);
      if (z === undefined) continue;
      if (!volume.instanceTransform.matrix) {
        const transform = cloneTransform(volume.instanceTransform);
        transform.offset[2] = z;
        volume.instanceTransform = transform;
        continue;
      }
      const matrix = matrixFromTransform(volume.instanceTransform);
      matrix.elements[14] = z;
      volume.instanceTransform = normalizeTransform(transformFromMatrix(matrix, volume.instanceTransform));
    }
  }

  private objectIndex(key: InstanceKey): number {
    return Number(key.split(':', 1)[0]);
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
  return volume.getWorldBounds();
}

function transformMatrix(transform: ModelTransform): THREE.Matrix4 {
  return matrixFromTransform(transform);
}

function linearPart(matrix: THREE.Matrix4): THREE.Matrix4 {
  return matrix.clone().setPosition(0, 0, 0);
}

/** Match Orca's NONE synchronization case: a world-Z rotation only. */
function isWorldZOnlyRotation(oldTransform: ModelTransform, nextTransform: ModelTransform): boolean {
  const oldMatrix = matrixFromTransform(oldTransform);
  const nextMatrix = matrixFromTransform(nextTransform);
  const oldLinear = linearPart(oldMatrix);
  const nextLinear = linearPart(nextMatrix);
  const oldColumns = [0, 4, 8].map((index) =>
    new THREE.Vector3(oldLinear.elements[index], oldLinear.elements[index + 1], oldLinear.elements[index + 2]),
  );
  const nextColumns = [0, 4, 8].map((index) =>
    new THREE.Vector3(nextLinear.elements[index], nextLinear.elements[index + 1], nextLinear.elements[index + 2]),
  );
  const epsilon = 1e-7;
  // Scaling, mirroring, and any other linear change require synchronization.
  for (let i = 0; i < 3; i++) {
    if (Math.abs(oldColumns[i].length() - nextColumns[i].length()) > epsilon) return false;
  }
  if (Math.sign(oldLinear.determinant()) !== Math.sign(nextLinear.determinant())) return false;

  const oldRotation = new THREE.Matrix4().extractRotation(oldLinear);
  const nextRotation = new THREE.Matrix4().extractRotation(nextLinear);
  const delta = nextRotation.multiply(oldRotation.invert());
  const transformedZ = new THREE.Vector3(0, 0, 1).applyMatrix4(delta);
  return Math.abs(transformedZ.x) <= epsilon && Math.abs(transformedZ.y) <= epsilon
    && Math.abs(transformedZ.z - 1) <= epsilon;
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
