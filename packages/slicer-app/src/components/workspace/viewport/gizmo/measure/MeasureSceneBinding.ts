import type { MeasureTarget } from '@slicer/client';
import * as THREE from 'three';
import { WipeTowerVolume } from '../../WipeTowerVolume';
import { matrixFromTransform } from '../../transformDeltaMath';
import type { InstanceHiderLease } from '../../InstanceHider';
import type { SceneInteractionController } from '../../SceneInteractionController';
import type { MeasureController } from './MeasureController';

function key(target: MeasureTarget): string {
  return `${target.objectId}:${target.instanceId}:${target.volumeId}`;
}

/** The scene owns the selected model IDs; Measure owns its native resources. */
export function measureTargets(scene: SceneInteractionController): MeasureTarget[] {
  return scene.selectedVolumes().filter(volume => !(volume instanceof WipeTowerVolume)).map(({ buffer }) => ({
    objectId: buffer.objectId, instanceId: buffer.instanceId, volumeId: buffer.volumeId,
  }));
}

function sameTargets(a: readonly MeasureTarget[], b: readonly MeasureTarget[]): boolean {
  const left = new Set(a.map(key));
  const right = new Set(b.map(key));
  return left.size === right.size && [...left].every(value => right.has(value));
}

type Projection = Map<string, { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }>;
function projection(scene: SceneInteractionController): Projection {
  return new Map(scene.selectedVolumes().filter(volume => !(volume instanceof WipeTowerVolume)).map(volume => [key(volume.buffer), {
    geometry: volume.geometry,
    matrix: matrixFromTransform(volume.instanceTransform).multiply(matrixFromTransform(volume.volumeTransform)),
  }]));
}
function sameProjection(a: Projection, b: Projection): boolean {
  if (a.size !== b.size) return false;
  for (const [id, current] of a) {
    const previous = b.get(id);
    if (!previous || current.geometry !== previous.geometry || !current.matrix.equals(previous.matrix)) return false;
  }
  return true;
}

/** Bridges scene-tool changes to the ordered Measure session. Restoration is
 * suspended until the native history operation and projection have finished. */
export class MeasureSceneBinding {
  private readonly unsubscribeImmediate: () => void;
  private readonly unsubscribeScene: () => void;
  private readonly unsubscribeMeasure: () => void;
  private isolation: InstanceHiderLease | null = null;
  private request = 0;
  private projection: Projection = new Map();

  constructor(
    private readonly scene: SceneInteractionController,
    private readonly measure: MeasureController,
    private readonly suspended: () => boolean,
  ) {
    this.unsubscribeImmediate = scene.subscribeImmediate(() => this.syncIsolation());
    this.unsubscribeScene = scene.subscribe(() => this.sync());
    let previousPhase = measure.getSnapshot().phase;
    this.unsubscribeMeasure = measure.subscribe(() => {
      const phase = measure.getSnapshot().phase;
      if (previousPhase === 'rebasing' && phase === 'idle' && scene.gizmo === 'measure') this.projection = projection(scene);
      previousPhase = phase;
      if (!this.suspended() && !measure.active && scene.gizmo === 'measure') scene.closeGizmo();
    });
    this.syncIsolation();
    this.sync();
  }

  /** Match visible volumes before scene observers see each state transition. */
  private syncIsolation(): void {
    if (this.scene.gizmo === 'measure') {
      const scope = { kind: 'volumes' as const, volumes: measureTargets(this.scene) };
      if (this.isolation) this.isolation.update(scope);
      else this.isolation = this.scene.instanceHider.acquire(scope);
    } else {
      this.isolation?.release();
      this.isolation = null;
    }
  }

  private sync(): void {
    if (this.suspended()) return;
    if (this.scene.gizmo !== 'measure') {
      this.request++;
      this.projection = new Map();
      if (this.measure.active) void this.measure.close();
      return;
    }
    const targets = measureTargets(this.scene);
    if (!targets.length) { this.scene.closeGizmo(); return; }
    const current = projection(this.scene);
    const targetChanged = !sameTargets(targets, this.measure.getSnapshot().targets);
    const projectionChanged = !sameProjection(current, this.projection);
    this.projection = current;
    if (!this.measure.active || targetChanged || (projectionChanged && this.measure.getSnapshot().phase !== 'rebasing')) {
      const request = ++this.request;
      void this.measure.open(targets).then(opened => {
        if (!opened && request === this.request && !this.suspended() && this.scene.gizmo === 'measure') this.scene.closeGizmo();
      });
    }
  }

  /** Native history resets its Measure sessions. Reopen with empty slots only
   * after a successful restore; failed history operations leave it intact. */
  async historyRestored(): Promise<void> {
    if (this.scene.gizmo !== 'measure') {
      if (this.measure.active) await this.measure.close();
      return;
    }
    const targets = measureTargets(this.scene);
    if (!targets.length) { this.scene.closeGizmo(); return; }
    this.projection = projection(this.scene);
    const request = ++this.request;
    const opened = await this.measure.open(targets);
    if (!opened && request === this.request && this.scene.gizmo === 'measure') this.scene.closeGizmo();
  }

  /** Close the local tool immediately and wait for admitted native cleanup. */
  async close(): Promise<void> {
    if (this.scene.gizmo === 'measure') this.scene.closeGizmo();
    if (this.measure.active) await this.measure.close();
    else await this.measure.settled();
  }

  dispose(): void {
    this.unsubscribeImmediate();
    this.unsubscribeScene();
    this.unsubscribeMeasure();
    this.isolation?.release();
    this.isolation = null;
    if (this.measure.active) void this.measure.close();
  }
}
