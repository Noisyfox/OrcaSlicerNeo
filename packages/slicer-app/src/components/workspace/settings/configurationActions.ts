import type { PlatformCapabilities } from '@orca/platform-contract';
import type { PlateSessionMutation } from '@slicer/client';
import { errorText } from '@orca/slicer-runtime';
import { useProjectStore } from '../../../stores/useProjectStore';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { applyPlateSessionTransforms } from '../actions/syncModelTransforms';
import { glVolumeCollection } from '../viewport/GLVolume';

/** Commit a shared configuration change through the WASM-owned plate session. */
export async function commitSharedConfigurationMutation(
  platform: PlatformCapabilities,
): Promise<PlateSessionMutation> {
  const markConfiguration = platform.runtime.markSharedConfigurationMutation;
  if (typeof markConfiguration !== 'function') {
    throw new Error('runtime does not support shared configuration mutations');
  }
  let mutation;
  try {
    mutation = await markConfiguration.call(platform.runtime);
  } catch (error) {
    throw new Error(errorText(error));
  }
  if (!mutation.ok) throw new Error(mutation.error ?? 'shared configuration mutation failed');
  const activeJob = useSlicerStore.getState().activeSliceTarget;
  if (activeJob && (mutation.affectedPlateIds ?? []).includes(activeJob.plateId)) {
    useSlicerStore.getState().invalidatePlateResults([activeJob.plateId]);
    void platform.runtime.cancel().catch(() => undefined);
  }
  applyPlateSessionTransforms(mutation, glVolumeCollection.volumes);
  usePlateSessionStore.getState().setSnapshot(mutation);
  useProjectStore.getState().recordPlateMutation(mutation);
  return mutation;
}

/** Clear stale slice UI after a successful shared configuration commit. */
export function invalidateAfterSharedConfigurationMutation(): void {
  // Shared printer/process/filament inputs are common to every plate. Keep
  // no completed result (or active job) across this boundary.
  useSlicerStore.getState().invalidateSliceResult();
}
