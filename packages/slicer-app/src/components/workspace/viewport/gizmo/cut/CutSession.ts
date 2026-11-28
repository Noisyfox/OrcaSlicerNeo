import { Box3, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { create } from 'zustand';
import type { CutRequest } from '@slicer/client';
import type { GLVolume } from '../../GLVolume';
import { matrixFromTransform } from '../../transformDeltaMath';

export type CutPose = Pick<CutRequest, 'center' | 'rotation'>;
type Draft = CutPose & Pick<CutRequest, 'upper' | 'lower' | 'asParts'>;
export interface CutTarget {
  objectId: number;
  instanceId: number;
  signature: string;
  initial: CutPose;
  radius: number;
}

export function cutTarget(selected: readonly GLVolume[], all: readonly GLVolume[]): CutTarget | null {
  const first = selected[0]?.buffer;
  if (!first || selected.some(v => v.kind !== 'model' || v.buffer.instanceId !== first.instanceId)) return null;
  const parts = all.filter(v => v.kind === 'model' && v.buffer.instanceId === first.instanceId);
  if (parts.length !== selected.length) return null;
  const bounds = new Box3();
  const signature = parts.map(part => {
    bounds.union(part.getWorldBounds());
    return [part.buffer.volumeId, part.geometry.uuid, ...matrixFromTransform(part.instanceTransform).elements,
      ...matrixFromTransform(part.volumeTransform).elements].join(',');
  }).join(';');
  if (bounds.isEmpty()) return null;
  return { objectId: first.objectId, instanceId: first.instanceId, signature,
    initial: { center: bounds.getCenter(new Vector3()).toArray(), rotation: [1,0,0,0,1,0,0,0,1] },
    radius: Math.max(2, bounds.getSize(new Vector3()).length() * 0.6) };
}

export const normalOf = (pose: CutPose) => new Vector3().fromArray(pose.rotation, 6);
export const quaternionOf = (pose: CutPose) => new Quaternion().setFromRotationMatrix(
  new Matrix4().setFromMatrix3(new Matrix3().fromArray(pose.rotation)));
export const rotationOf = (q: Quaternion): CutPose['rotation'] =>
  new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(q)).toArray();

/** Shift-drag defines the plane through the drawn line, parallel to the
 * viewing direction. Keep the old center's projection onto that plane. */
export function drawnPlane(pose: CutPose, from: Vector3, to: Vector3, view: Vector3): CutPose | null {
  const n = to.clone().sub(from).cross(view).normalize();
  if (!n.lengthSq()) return null;
  const center = new Vector3(...pose.center);
  center.addScaledVector(n, from.clone().sub(center).dot(n));
  return { center: center.toArray(), rotation: rotationOf(new Quaternion().setFromUnitVectors(new Vector3(0,0,1), n)) };
}

export const useCutHistory = create<{ session: CutSession | null; undo: boolean; redo: boolean }>(
  () => ({ session: null, undo: false, redo: false }));

export class CutSession {
  target: CutTarget | null = null;
  draft: Draft | null = null;
  revision: number | null = null;
  busy = false;
  private past: Draft[] = [];
  private future: Draft[] = [];
  private start: Draft | null = null;
  private remembered: { signature: string; pose: CutPose } | null = null;
  constructor(private readonly emit: () => void) {}

  open(target: CutTarget, revision: number | null) {
    this.target = target;
    this.revision = revision;
    const pose = this.remembered?.signature === target.signature ? this.remembered.pose : target.initial;
    this.draft = { ...pose, upper: 'place', lower: 'keep', asParts: false };
    this.past = []; this.future = []; this.start = null;
    this.notify();
  }
  close(remember = true) {
    if (!this.target || !this.draft) return;
    const { center, rotation } = this.start ?? this.draft;
    this.remembered = remember ? { signature: this.target.signature, pose: { center, rotation } } : null;
    this.target = null; this.draft = null; this.start = null;
    this.past = []; this.future = [];
    this.notify();
  }
  private notify() {
    useCutHistory.setState({ session: this.draft ? this : null, undo: !!this.past.length && !this.busy,
      redo: !!this.future.length && !this.busy });
    this.emit();
  }
  begin() { if (this.draft && !this.busy && !this.start) this.start = this.draft; }
  update(patch: Partial<Draft>) {
    if (!this.draft || this.busy) return;
    const next = { ...this.draft, ...patch };
    if (next.asParts && (next.upper === 'discard' || next.lower === 'discard')) {
      if (next.upper === 'discard') next.upper = 'keep';
      if (next.lower === 'discard') next.lower = 'keep';
    }
    if (JSON.stringify(next) === JSON.stringify(this.draft)) return;
    if (!this.start) { this.past.push(this.draft); this.future = []; }
    this.draft = next;
    this.notify();
  }
  finish(cancel = false) {
    if (!this.start || !this.draft) return;
    if (cancel) this.draft = this.start;
    else if (JSON.stringify(this.start) !== JSON.stringify(this.draft)) { this.past.push(this.start); this.future = []; }
    this.start = null;
    this.notify();
  }
  navigate(direction: 'undo' | 'redo') {
    if (!this.draft || this.busy || this.start) return;
    const from = direction === 'undo' ? this.past : this.future;
    const previous = from.pop();
    if (previous) {
      (direction === 'undo' ? this.future : this.past).push(this.draft);
      this.draft = previous;
      this.notify();
    }
  }
  move(distance: number, pose: CutPose | null = this.draft) {
    if (pose) this.update({ center: new Vector3(...pose.center).addScaledVector(normalOf(pose), distance).toArray() });
  }
  flip() {
    if (this.draft) this.update({ rotation: rotationOf(quaternionOf(this.draft)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(1,0,0), Math.PI))) });
  }
  setRevision(target: CutTarget, revision: number) {
    if (this.target === target && this.revision === null) { this.revision = revision; this.notify(); }
  }
  setBusy(value: boolean) { this.busy = value; this.notify(); }
}
