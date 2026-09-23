import type { PlatformCapabilities } from '@orca/platform-contract';
import type {
  NativeScopedConfigMutationRequest,
  NativeScopedConfigTarget,
  NativeScopedConfigTransport,
  PlateSessionMutation,
  PlateSessionMutationResult,
} from '@slicer/client';
import { errorText } from '@orca/slicer-runtime';
import { useProjectStore } from '../../../stores/useProjectStore';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { applyPlateSessionTransforms } from '../actions/syncModelTransforms';
import { glVolumeCollection } from '../viewport/GLVolume';
import { runProjectHistoryMutation } from '../actions/historyMutation';

let configurationMutationQueue: Promise<void> = Promise.resolve();

type ConfigurationMutationResult = PlateSessionMutationResult | {
  ok: true;
  unchanged: true;
  nativeScopedConfig: NativeScopedConfigTransport;
};

/** Let actions that consume settings wait for a pending blur/selection commit. */
export function waitForConfigurationMutations(): Promise<void> {
  return configurationMutationQueue;
}

async function commitSharedConfigurationMutationNow(
  platform: PlatformCapabilities,
  optionKey?: string,
  value?: string,
  target: NativeScopedConfigTarget = { scope: 'project' },
): Promise<PlateSessionMutation | null> {
  let mutation: ConfigurationMutationResult | undefined;
  try {
    const history = await runProjectHistoryMutation<ConfigurationMutationResult>(
      platform.runtime,
      'Change Project Configuration',
      async () => {
        if (optionKey !== undefined) {
          const result = await platform.runtime.setNativeScopedConfig(target, optionKey, value ?? '');
          if (!result.ok) throw new Error(result.error);
          if (result.configurationStatus?.state === 'ready' && result.configurationStatus.errors.length > 0)
            throw new Error(result.configurationStatus.errors.join('; '));
          if (result.configurationStatus?.state === 'ready' && result.configurationStatus.warnings.length > 0)
            useSlicerStore.getState().setError(`[Warning] ${result.configurationStatus.warnings.join('; ')}`);
          if (!result.plateSession) return { ok: true, unchanged: true, nativeScopedConfig: result.nativeScopedConfig };
          return { ...result.plateSession, nativeScopedConfig: result.nativeScopedConfig };
        }
        return platform.runtime.markSharedConfigurationMutation();
      },
      null,
      {
        publish: async (published, status) => {
          if (!published.ok || 'unchanged' in published) return;
          if (status?.nativeScopedConfig) {
            const outcome = useSettingsStore.getState().applyNativeScopedConfigTransport(status.nativeScopedConfig);
            if (outcome === 'refresh-required') {
              const refreshed = await platform.runtime.getNativeScopedConfig();
              if (!refreshed.ok || useSettingsStore.getState().applyNativeScopedConfigTransport(refreshed.nativeScopedConfig) !== 'applied')
                throw new Error(refreshed.ok ? 'native scoped configuration refresh was not accepted' : refreshed.error);
            }
          }
          mutation = published;
          const activeJob = useSlicerStore.getState().activeSliceTarget;
          if (activeJob && (published.affectedPlateIds ?? []).includes(activeJob.plateId)) {
            useSlicerStore.getState().invalidatePlateResults([activeJob.plateId]);
            void platform.runtime.cancel().catch(() => undefined);
          }
          applyPlateSessionTransforms(published, glVolumeCollection.volumes);
          usePlateSessionStore.getState().setSnapshot(published);
          useProjectStore.getState().recordPlateMutation(published);
        },
      },
    );
    mutation = history.result;
  } catch (error) {
    const message = errorText(error);
    useSlicerStore.getState().setError(message);
    throw new Error(message);
  }
  if (mutation && !mutation.ok) {
    const message = mutation.error ?? 'shared configuration mutation failed';
    useSlicerStore.getState().setError(message);
    throw new Error(message);
  }
  if (!mutation) throw new Error('shared configuration mutation was not published');
  return 'unchanged' in mutation ? null : mutation;
}

/** Commit a shared configuration change through the WASM-owned plate session. */
export function commitSharedConfigurationMutation(
  platform: PlatformCapabilities,
  optionKey?: string,
  value?: string,
  target?: NativeScopedConfigTarget,
): Promise<PlateSessionMutation | null> {
  const task = configurationMutationQueue.then(() =>
    commitSharedConfigurationMutationNow(platform, optionKey, value, target));
  configurationMutationQueue = task.then(() => undefined, () => undefined);
  return task;
}

/** Commit one atomic native set/reset operation for all resolved targets. The
 * request is captured before dispatch; selection changes after this point do
 * not retarget the Worker transaction. */
async function commitScopedConfigurationMutationNow(
  platform: PlatformCapabilities,
  request: NativeScopedConfigMutationRequest,
): Promise<PlateSessionMutation | null> {
  let mutation: ConfigurationMutationResult | undefined;
  try {
    const history = await runProjectHistoryMutation<ConfigurationMutationResult>(
      platform.runtime,
      request.operation === 'set' ? 'Change Scoped Configuration' : 'Reset Scoped Configuration',
      async (): Promise<ConfigurationMutationResult> => {
        const result = await platform.runtime.mutateNativeScopedConfig(request);
        if (!result.ok) throw new Error(result.error);
        if (result.configurationStatus?.state === 'ready' && result.configurationStatus.errors.length > 0)
          throw new Error(result.configurationStatus.errors.join('; '));
        if (!result.plateSession) return { ok: true, unchanged: true, nativeScopedConfig: result.nativeScopedConfig };
        return { ...result.plateSession, nativeScopedConfig: result.nativeScopedConfig };
      },
      null,
      {
        publish: async (published, status) => {
          if (!published.ok || 'unchanged' in published) return;
          if (status?.nativeScopedConfig) {
            const outcome = useSettingsStore.getState().applyNativeScopedConfigTransport(status.nativeScopedConfig);
            if (outcome === 'refresh-required') {
              const refreshed = await platform.runtime.getNativeScopedConfig();
              if (!refreshed.ok || useSettingsStore.getState().applyNativeScopedConfigTransport(refreshed.nativeScopedConfig) !== 'applied')
                throw new Error(refreshed.ok ? 'native scoped configuration refresh was not accepted' : refreshed.error);
            }
          }
          mutation = published;
          const activeJob = useSlicerStore.getState().activeSliceTarget;
          if (activeJob && (published.affectedPlateIds ?? []).includes(activeJob.plateId)) {
            useSlicerStore.getState().invalidatePlateResults([activeJob.plateId]);
            void platform.runtime.cancel().catch(() => undefined);
          }
          applyPlateSessionTransforms(published, glVolumeCollection.volumes);
          usePlateSessionStore.getState().setSnapshot(published);
          useProjectStore.getState().recordPlateMutation(published);
        },
      },
    );
    mutation = history.result;
  } catch (error) {
    const message = errorText(error);
    useSlicerStore.getState().setError(message);
    throw new Error(message);
  }
  if (mutation && !mutation.ok) {
    const message = mutation.error ?? 'scoped configuration mutation failed';
    useSlicerStore.getState().setError(message);
    throw new Error(message);
  }
  if (!mutation) throw new Error('scoped configuration operation was not published');
  return 'unchanged' in mutation ? null : mutation;
}

/** Commit one scoped configuration operation in the same FIFO used by the
 * shared-setting path. Slice actions await this queue before starting,
 * so a pending text blur can never race a slice request. */
export function commitScopedConfigurationMutation(
  platform: PlatformCapabilities,
  request: NativeScopedConfigMutationRequest,
): Promise<PlateSessionMutation | null> {
  const task = configurationMutationQueue.then(() =>
    commitScopedConfigurationMutationNow(platform, request));
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
  // A draft project edit has no native affected receipt yet, so it represents
  // the explicit shared-configuration boundary and hides every plate result.
  const existingStatus = useSlicerStore.getState().error;
  if (affectedPlateIds !== undefined) useSlicerStore.getState().invalidatePlateResults(affectedPlateIds);
  else useSlicerStore.getState().invalidateSliceResult();
  // Native configuration warnings are successful-command status, not stale
  // slice errors. Preserve the visible warning while the result projection is
  // invalidated; ordinary errors retain the existing clearing behaviour.
  if (existingStatus?.startsWith('[Warning]')) useSlicerStore.getState().setError(existingStatus);
}
