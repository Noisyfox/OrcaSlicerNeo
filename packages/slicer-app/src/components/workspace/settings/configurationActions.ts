import type { PlatformCapabilities } from '@orca/platform-contract';
import type { PlateSessionMutation, ProjectConfigOverrideTarget } from '@slicer/client';
import { errorText } from '@orca/slicer-runtime';
import { useProjectStore } from '../../../stores/useProjectStore';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { applyPlateSessionTransforms } from '../actions/syncModelTransforms';
import { glVolumeCollection } from '../viewport/GLVolume';
import { runProjectHistoryMutation, syncHistoryStatus } from '../actions/historyMutation';

let configurationMutationQueue: Promise<void> = Promise.resolve();

/** Let actions that consume settings wait for a pending blur/selection commit. */
export function waitForConfigurationMutations(): Promise<void> {
  return configurationMutationQueue;
}

async function commitSharedConfigurationMutationNow(
  platform: PlatformCapabilities,
  optionKey?: string,
  value?: string,
  target: ProjectConfigOverrideTarget = { scope: 'project' },
): Promise<PlateSessionMutation> {
  let mutation;
  try {
    mutation = (await runProjectHistoryMutation(
      platform.runtime,
      'Change Project Configuration',
      async () => {
        if (optionKey !== undefined) {
          const result = await platform.runtime.setProjectConfigOverride(target, optionKey, value ?? '');
          if (!result.ok) throw new Error(result.error);
          if (result.configurationStatus?.state === 'ready' && result.configurationStatus.errors.length > 0)
            throw new Error(result.configurationStatus.errors.join('; '));
          if (result.configurationStatus?.state === 'ready' && result.configurationStatus.warnings.length > 0)
            useSlicerStore.getState().setError(`[Warning] ${result.configurationStatus.warnings.join('; ')}`);
          useSettingsStore.getState().setOverlay(result.overlay);
          if (result.plateSession === undefined) throw new Error('configuration override returned no plate session');
          return result.plateSession;
        }
        return platform.runtime.markSharedConfigurationMutation();
      },
    )).result;
  } catch (error) {
    const message = errorText(error);
    useSlicerStore.getState().setError(message);
    throw new Error(message);
  }
  if (!mutation.ok) {
    const message = mutation.error ?? 'shared configuration mutation failed';
    useSlicerStore.getState().setError(message);
    throw new Error(message);
  }
  const activeJob = useSlicerStore.getState().activeSliceTarget;
  if (activeJob && (mutation.affectedPlateIds ?? []).includes(activeJob.plateId)) {
    useSlicerStore.getState().invalidatePlateResults([activeJob.plateId]);
    void platform.runtime.cancel().catch(() => undefined);
  }
  applyPlateSessionTransforms(mutation, glVolumeCollection.volumes);
  usePlateSessionStore.getState().setSnapshot(mutation);
  useProjectStore.getState().recordPlateMutation(mutation);
  await syncHistoryStatus(platform.runtime);
  return mutation;
}

/** Commit a shared configuration change through the WASM-owned plate session. */
export function commitSharedConfigurationMutation(
  platform: PlatformCapabilities,
  optionKey?: string,
  value?: string,
  target?: ProjectConfigOverrideTarget,
): Promise<PlateSessionMutation> {
  const task = configurationMutationQueue.then(() =>
    commitSharedConfigurationMutationNow(platform, optionKey, value, target));
  configurationMutationQueue = task.then(() => undefined, () => undefined);
  return task;
}

/** Preset selection is global/session state, so it advances slicing inputs
 * without entering the project history stack. */
export async function applyPresetConfigurationMutation(platform: PlatformCapabilities): Promise<PlateSessionMutation> {
  const result = await platform.runtime.markSharedConfigurationMutation();
  if (!result.ok) throw new Error(result.error ?? 'preset configuration transition failed');
  const activeJob = useSlicerStore.getState().activeSliceTarget;
  if (activeJob && (result.affectedPlateIds ?? []).includes(activeJob.plateId)) {
    useSlicerStore.getState().invalidatePlateResults([activeJob.plateId]);
    void platform.runtime.cancel().catch(() => undefined);
  }
  applyPlateSessionTransforms(result, glVolumeCollection.volumes);
  usePlateSessionStore.getState().setSnapshot(result);
  useProjectStore.getState().recordPlateMutation(result);
  return result;
}

/** Clear stale slice UI after a successful shared configuration commit. */
export function invalidateAfterSharedConfigurationMutation(affectedPlateIds?: readonly string[]): void {
  // Native object/part overrides return their exact affected plate set;
  // consume it so an edit cannot discard an unrelated completed plate.  A
  // missing set denotes the shared project/preset boundary and conservatively
  // clears every result.
  const existingStatus = useSlicerStore.getState().error;
  if (affectedPlateIds !== undefined) useSlicerStore.getState().invalidatePlateResults(affectedPlateIds);
  else useSlicerStore.getState().invalidateSliceResult();
  // Native configuration warnings are successful-command status, not stale
  // slice errors. Preserve the visible warning while the result projection is
  // invalidated; ordinary errors retain the existing clearing behaviour.
  if (existingStatus?.startsWith('[Warning]')) useSlicerStore.getState().setError(existingStatus);
}
