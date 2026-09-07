import { emptyProjectConfigOverlay, useSettingsStore } from '../../../stores/useSettingsStore';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { glVolumeCollection } from '../viewport/GLVolume';

/**
 * The small renderer-facing surface needed when the runtime has successfully
 * replaced the complete model.  Keeping this outside projectActions avoids
 * making project lifecycle code depend on a concrete viewport controller.
 */
export interface SceneResetTarget {
  resetForModel(): void;
}

/**
 * Clear every renderer projection of the old model after the runtime commit.
 * Callers must invoke this only after the corresponding runtime operation has
 * returned `{ ok: true }`; before that point the old scene remains intact.
 */
export function resetSceneState(target?: SceneResetTarget | null, options?: { clearSettings?: boolean }): void {
  glVolumeCollection.clear();
  if (options?.clearSettings) useSettingsStore.getState().setOverlay(emptyProjectConfigOverlay());
  useSettingsStore.getState().setModelLoaded(false);
  useSlicerStore.getState().invalidateSliceResult();
  target?.resetForModel();
}
