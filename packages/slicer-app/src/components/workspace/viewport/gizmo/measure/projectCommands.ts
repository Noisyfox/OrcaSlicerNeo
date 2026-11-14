import type { MeasureController } from './MeasureController';
import type { MeasureSceneBinding } from './MeasureSceneBinding';

let owner: MeasureController | null = null;
let scene: MeasureSceneBinding | null = null;

export function registerMeasureCommands(controller: MeasureController): () => void {
  owner = controller;
  return () => { if (owner === controller) owner = null; };
}

export function registerMeasureScene(binding: MeasureSceneBinding): () => void {
  scene = binding;
  return () => { if (scene === binding) scene = null; };
}

export function measureSessionActive(): boolean { return owner?.active ?? false; }

export interface MeasureMutationTargets {
  readonly all?: boolean;
  readonly objects?: readonly number[];
  readonly parts?: readonly number[];
  readonly instances?: readonly number[];
}

/** Reject synchronously, before project FIFO admission. A source volume is
 * shared by every rendered instance, so its stable ID protects them all. */
export function measureMutationAllowed(change: MeasureMutationTargets): boolean {
  if (!owner?.active) return true;
  const targets = owner.getSnapshot().targets;
  const blocked = !!change.all || targets.some(target => change.objects?.includes(target.objectId) ||
    change.parts?.includes(target.volumeId) || change.instances?.includes(target.instanceId));
  if (blocked) owner.reportTargetProtected();
  return !blocked;
}

/** Close the local tool before waiting for its native session to finish. */
export async function closeMeasureForCommand(): Promise<void> {
  if (scene) await scene.close();
  else if (owner?.active) await owner.close();
  else if (owner) await owner.settled();
}
