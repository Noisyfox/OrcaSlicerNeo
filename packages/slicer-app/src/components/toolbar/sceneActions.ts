// Shared Add Model / Add Primitive / Clear Scene actions. They moved out of
// the app toolbar row (Add Model → gizmo toolbar, Add Primitive + Clear
// Scene → scene context menu), but the store/runtime choreography is
// identical for every surface that invokes them, so they live here once.
import type { PlatformCapabilities } from '@orca/platform-contract';
import { errorText } from '@orca/slicer-runtime';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { waitForSettledModelTransforms } from './persistModelTransforms';

/**
 * Shared post-add choreography for file imports and engine-built primitives:
 * wait for a just-finished transform commit, append the model through the
 * runtime, then flip the shared model/result state and reset the scene
 * interaction. Only a successful add changes the plate — a dialog cancel or
 * parse failure must leave the existing scene and its sliced result intact.
 */
async function commitAdded(
  platform: PlatformCapabilities,
  sceneInteraction: SceneInteractionController | null,
  displayName: string,
  add: () => Promise<{ ok: boolean; error?: string }>,
): Promise<void> {
  // A just-finished gesture persists its settled state on release. Wait for
  // that commit before the additive import refreshes the collection.
  const synced = await waitForSettledModelTransforms();
  if (!synced.ok) throw new Error(synced.error ?? 'model synchronization failed');
  const r = await add();
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
    await commitAdded(platform, sceneInteraction, file.displayName,
      () => platform.runtime.addModel(file.bytes, ext));
  } catch (err) {
    // errorText unwraps "Error: <msg>" (String(err)); the status bar
    // already prefixes "Error" (StatusBar statusText).
    useSlicerStore.getState().setError(errorText(err));
    console.error('add model failed:', err);
  }
}

// The OrcaSlicer "Add Primitive" submenu set (GUI_Factories.cpp
// append_submenu_add_generic with ModelVolumeType::INVALID): the shapes
// orc_add_shape can build. Text/SVG remain desktop-host features (they open
// the text/SVG gizmos), and are not in the WASM build.
export const PRIMITIVE_TYPES = ['Cube', 'Cylinder', 'Sphere', 'Cone', 'Disc', 'Torus'] as const;
export type PrimitiveType = (typeof PRIMITIVE_TYPES)[number];

/**
 * Append an OrcaSlicer primitive to the live scene exactly like OrcaSlicer's
 * Add Primitive: the engine builds the mesh (bridge.cpp orc_add_shape
 * mirrors ObjectList::load_shape_object → create_mesh → load_mesh_object)
 * and adds the object and its part named after the primitive — no staging
 * file, no filename-derived names.
 */
export async function addPrimitive(
  platform: PlatformCapabilities,
  sceneInteraction: SceneInteractionController | null,
  type: PrimitiveType,
): Promise<void> {
  try {
    await commitAdded(platform, sceneInteraction, type, () => platform.runtime.addShape(type));
  } catch (err) {
    useSlicerStore.getState().setError(errorText(err));
    console.error(`add primitive failed: ${type}`, err);
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
