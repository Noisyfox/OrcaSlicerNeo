import type { MeasureTarget } from '@slicer/client';
import { WipeTowerVolume } from '../../WipeTowerVolume';
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

/** Bridges scene-tool changes to the ordered Measure session. Restoration is
 * suspended until the native history operation and projection have finished. */
export class MeasureSceneBinding {
  private readonly unsubscribeScene: () => void;
  private readonly unsubscribeMeasure: () => void;
  private request = 0;

  constructor(
    private readonly scene: SceneInteractionController,
    private readonly measure: MeasureController,
    private readonly suspended: () => boolean,
  ) {
    this.unsubscribeScene = scene.subscribe(() => this.sync());
    this.unsubscribeMeasure = measure.subscribe(() => {
      if (!this.suspended() && !measure.active && scene.gizmo === 'measure') scene.closeGizmo();
    });
    this.sync();
  }

  private sync(): void {
    if (this.suspended()) return;
    if (this.scene.gizmo !== 'measure') {
      this.request++;
      if (this.measure.active) void this.measure.close();
      return;
    }
    const targets = measureTargets(this.scene);
    if (!targets.length) { this.scene.closeGizmo(); return; }
    if (!this.measure.active || !sameTargets(targets, this.measure.getSnapshot().targets)) {
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
    this.unsubscribeScene();
    this.unsubscribeMeasure();
    if (this.measure.active) void this.measure.close();
  }
}
