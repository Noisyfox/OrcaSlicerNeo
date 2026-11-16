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

/** Close the local tool before waiting for its native session to finish. */
export async function closeMeasureForCommand(): Promise<void> {
  if (scene) await scene.close();
  else if (owner?.active) await owner.close();
  else if (owner) await owner.settled();
}
