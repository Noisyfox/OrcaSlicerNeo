// Shared Add Model / Add Cube / Clear Scene actions. They moved out of the
// app toolbar row (Add Model → gizmo toolbar, Add Cube + Clear Scene → scene
// context menu), but the store/runtime choreography is identical for every
// surface that invokes them, so they live here once.
import type { PlatformCapabilities } from '@orca/platform-contract';
import { errorText } from '@orca/slicer-runtime';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { createCubeStl } from '../../lib/cubeStl';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { waitForSettledModelTransforms } from './persistModelTransforms';

/**
 * Shared post-add choreography for file imports and generated primitives:
 * wait for a just-finished transform commit, append the bytes through the
 * runtime, then flip the shared model/result state and reset the scene
 * interaction. Only a successful add changes the plate — a dialog cancel or
 * parse failure must leave the existing scene and its sliced result intact.
 */
async function commitAddedModel(
  platform: PlatformCapabilities,
  sceneInteraction: SceneInteractionController | null,
  bytes: Uint8Array,
  ext: string,
  displayName: string,
): Promise<void> {
  // A just-finished gesture persists its settled state on release. Wait for
  // that commit before the additive import refreshes the collection.
  const synced = await waitForSettledModelTransforms();
  if (!synced.ok) throw new Error(synced.error ?? 'model synchronization failed');
  const r = await platform.runtime.addModel(bytes, ext);
  if (!r.ok) throw new Error(r.error ?? 'add failed');
  const slicer = useSlicerStore.getState();
  const settings = useSettingsStore.getState();
  slicer.setStatus('idle');
  slicer.setResultExported(false);
  // Shared state receives only the display name; host-private absolute
  // paths must never cross the platform boundary.
  settings.setValue('modelPath', displayName);
  settings.setModelLoaded(true);
  sceneInteraction?.resetForModel();
  slicer.setError(null);
}

/**
 * Import a model through the host file picker and append it to the live
 * scene.
 */
export async function addModel(
  platform: PlatformCapabilities,
  sceneInteraction: SceneInteractionController | null,
): Promise<void> {
  const file = await platform.models.pick();
  if (!file) return;
  try {
    const ext = file.displayName.split('.').pop() ?? 'stl';
    await commitAddedModel(platform, sceneInteraction, file.bytes, ext, file.displayName);
  } catch (err) {
    // errorText unwraps "Error: <msg>" (String(err)); the status bar
    // already prefixes "Error" (StatusBar statusText).
    useSlicerStore.getState().setError(errorText(err));
    console.error('add model failed:', err);
  }
}

/**
 * Append OrcaSlicer's 20 mm cube primitive to the live scene, reusing the
 * standard model-import pipeline (see lib/cubeStl.ts).
 */
export async function addCube(
  platform: PlatformCapabilities,
  sceneInteraction: SceneInteractionController | null,
): Promise<void> {
  try {
    await commitAddedModel(platform, sceneInteraction, createCubeStl(), 'stl', 'Cube');
  } catch (err) {
    useSlicerStore.getState().setError(errorText(err));
    console.error('add cube failed:', err);
  }
}

/**
 * Explicitly reset the WASM model, slicer result, renderer collection, and
 * selection. No-op while slicing or when the plate is already empty.
 */
export async function clearScene(
  platform: PlatformCapabilities,
  sceneInteraction: SceneInteractionController | null,
): Promise<void> {
  const slicer = useSlicerStore.getState();
  const settings = useSettingsStore.getState();
  if (slicer.status === 'slicing' || !settings.modelLoaded) return;
  try {
    const r = await platform.runtime.clearModel();
    if (!r.ok) throw new Error(r.error ?? 'clear scene failed');
    slicer.setStatus('idle');
    slicer.setResultExported(false);
    settings.setModelLoaded(false);
    sceneInteraction?.resetForModel();
    slicer.setError(null);
  } catch (err) {
    slicer.setError(errorText(err));
    console.error('clear scene failed:', err);
  }
}
