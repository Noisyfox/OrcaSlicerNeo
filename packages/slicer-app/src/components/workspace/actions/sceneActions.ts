// Shared Add Model / Add Primitive / Add Handy models / Clear Scene actions.
// They moved out of the app toolbar row (Add Model → gizmo toolbar; Add
// Primitive, Add Handy models, and Clear Scene → scene context menu), but
// the store/runtime choreography is identical for every surface that invokes
// them, so they live here once.
import type { PlatformCapabilities } from '@orca/platform-contract';
import { errorText } from '@orca/slicer-runtime';
import type { PlateSessionMutation } from '@slicer/client';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { waitForSettledModelTransforms } from './persistModelTransforms';
import { applyPlateSessionTransforms } from './syncModelTransforms';
import { glVolumeCollection } from '../viewport/GLVolume';
import { applyPlateResultMutation } from '../../../stores/plateResultLifecycle';
import { HANDY_MODELS, type HandyModel } from '../../../resources/handyModels';

export { HANDY_MODELS, type HandyModel } from '../../../resources/handyModels';

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
  add: () => Promise<{ ok: boolean; error?: string; plateSession?: PlateSessionMutation }>,
): Promise<void> {
  // A just-finished gesture persists its settled state on release. Wait for
  // that commit before the additive import refreshes the collection.
  const synced = await waitForSettledModelTransforms();
  if (!synced.ok) throw new Error(synced.error ?? 'model synchronization failed');
  const r = await add();
  if (!r.ok) throw new Error(r.error ?? 'add failed');
  applyPlateSessionTransforms(r.plateSession, glVolumeCollection.volumes);
  const slicer = useSlicerStore.getState();
  const settings = useSettingsStore.getState();
  slicer.setStatus('idle');
  slicer.setResultExported(false);
  // Shared state receives only the display name; host-private absolute
  // paths must never cross the platform boundary.
  settings.setValue('modelPath', displayName);
  settings.setModelLoaded(true);
  useProjectStore.getState().setProject({ hasContent: true });
  if (r.plateSession) {
    const previousPlateSession = usePlateSessionStore.getState().snapshot;
    usePlateSessionStore.getState().setSnapshot(r.plateSession);
    applyPlateResultMutation(r.plateSession, previousPlateSession);
    useProjectStore.getState().recordPlateMutation(r.plateSession);
  }
  else useProjectStore.getState().markDirty('model-import');
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
    const ext = (file.displayName.split('.').pop() ?? 'stl').toLowerCase();
    await commitAdded(platform, sceneInteraction, file.displayName,
      () => platform.runtime.addModel(file.bytes, ext, file.displayName));
  } catch (err) {
    // errorText unwraps "Error: <msg>" (String(err)); the status bar
    // already prefixes "Error" (StatusBar statusText).
    const ext = (file.displayName.split('.').pop() ?? '').toLowerCase();
    useSlicerStore.getState().setError(ext === 'drc' ? 'Unable to import DRC file' : errorText(err));
    console.error('add model failed:', err);
  }
}

async function fetchHandyModelFile(fileName: string): Promise<Uint8Array> {
  // document.baseURI tracks Vite's configured base, including a Web
  // subpath deployment; it is also the loopback origin Electron serves its
  // renderer from. No host path or remote service is involved.
  // The Node-only unit suite has no DOM; its fixed origin is only a test
  // fallback and is never used by either product host.
  const deploymentBase = typeof document === 'undefined' ? 'http://localhost/' : document.baseURI;
  const url = new URL(fileName, new URL('handy-models/', deploymentBase));
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`handy model asset request failed (${response.status}): ${fileName}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Append one of OrcaSlicer's bundled handy-model entries. The two compound
 * entries preserve the source order used by Orca desktop's `load_files`.
 * Resource bytes are fetched before changing the scene so a missing asset
 * cannot partially add a model.
 */
export async function addHandyModel(
  platform: PlatformCapabilities,
  sceneInteraction: SceneInteractionController | null,
  model: HandyModel,
): Promise<void> {
  try {
    const files = await Promise.all(model.files.map(async (displayName) => ({
      displayName,
      bytes: await fetchHandyModelFile(displayName),
    })));
    await commitAdded(platform, sceneInteraction, model.label, async () => {
      let plateSession: PlateSessionMutation | undefined;
      for (const file of files) {
        const ext = (file.displayName.split('.').pop() ?? '').toLowerCase();
        const result = await platform.runtime.addModel(file.bytes, ext, file.displayName);
        if (!result.ok) return result;
        plateSession = result.plateSession ?? plateSession;
      }
      return { ok: true, plateSession };
    });
  } catch (err) {
    useSlicerStore.getState().setError(errorText(err));
    console.error(`add handy model failed: ${model.label}`, err);
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
    applyPlateSessionTransforms(r.plateSession, glVolumeCollection.volumes);
    slicer.setStatus('idle');
    slicer.setResultExported(false);
    settings.setModelLoaded(false);
    useProjectStore.getState().setProject({ hasContent: false });
    if (r.plateSession) {
      const previousPlateSession = usePlateSessionStore.getState().snapshot;
      usePlateSessionStore.getState().setSnapshot(r.plateSession);
      applyPlateResultMutation(r.plateSession, previousPlateSession);
      useProjectStore.getState().recordPlateMutation(r.plateSession);
    }
    else useProjectStore.getState().markDirty('model-clear');
    sceneInteraction?.resetForModel();
    slicer.setError(null);
  } catch (err) {
    slicer.setError(errorText(err));
    console.error('clear scene failed:', err);
  }
}
