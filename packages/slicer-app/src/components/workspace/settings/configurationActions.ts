import { publishRememberedBedType } from '@/preferences';
import { invalidateAffectedPlateResults } from '@/stores/plateResultLifecycle';
import { paintingCommandAllowed } from '../viewport/gizmo/painting/projectCommands';
import { unstable_batchedUpdates } from 'react-dom';
import type { PlatformCapabilities } from '@orca/platform-contract';
import type {
  NativeScopedConfigMutationRequest,
  NativeScopedConfigTransport,
  PresetDraftMutationRequest,
  PresetDraftMutationResult,
  PlateSessionMutation,
  PlateSessionMutationResult,
} from '@slicer/client';
import type { SlicerClient } from '@slicer/client';
import { errorText } from '@orca/slicer-runtime';
import { useProjectStore } from '@/stores/useProjectStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import { applyPlateSessionTransforms } from '../actions/syncModelTransforms';
import { glVolumeCollection } from '../viewport/GLVolume';
import { projectHistoryStatus, runProjectHistoryMutation, runProjectMutationOperation } from '../actions/historyMutation';
import { useHistoryNavigationStore } from '@/stores/useHistoryNavigationStore';

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

/** Commit one atomic native set/reset operation for all resolved targets. The
 * request is captured before dispatch; selection changes after this point do
 * not retarget the Worker transaction. */
async function commitScopedConfigurationMutationNow(
  platform: PlatformCapabilities,
  request: NativeScopedConfigMutationRequest,
): Promise<PlateSessionMutation | null> {
  let mutation: ConfigurationMutationResult | undefined;
  let previousBed: string | undefined;
  try {
    const history = await runProjectHistoryMutation<ConfigurationMutationResult>(
      platform.runtime,
      request.operation === 'set' ? 'Change Scoped Configuration' : 'Reset Scoped Configuration',
      async (): Promise<ConfigurationMutationResult> => {
        previousBed = useSettingsStore.getState().nativeScopedConfig.project.curr_bed_type;
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
          // Publish result ownership with the native receipt, before slower
          // preference persistence. Every caller shares this invalidation.
          invalidateAfterSharedConfigurationMutation(published.affectedPlateIds, platform.runtime);
          applyPlateSessionTransforms(published, glVolumeCollection.volumes);
          usePlateSessionStore.getState().setSnapshot(published);
          useProjectStore.getState().recordPlateMutation(published);
          if (request.targets.some(target => target.scope === 'project') &&
              useSettingsStore.getState().nativeScopedConfig.project.curr_bed_type !== previousBed) {
            const settings = useSettingsStore.getState();
            await publishRememberedBedType(platform.preferences, settings.selectedPrinter,
              settings.nativeScopedConfig.project.curr_bed_type);
          }
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

/** Commit one scoped configuration operation in the shared mutation FIFO.
 * Slice actions await this queue before starting,
 * so a pending text blur can never race a slice request. */
export function commitScopedConfigurationMutation(
  platform: PlatformCapabilities,
  request: NativeScopedConfigMutationRequest,
): Promise<PlateSessionMutation | null> {
  if (!paintingCommandAllowed()) return Promise.resolve(null);
  const task = configurationMutationQueue.then(() =>
    commitScopedConfigurationMutationNow(platform, request));
  configurationMutationQueue = task.then(() => undefined, () => undefined);
  return task;
}

/** Commit and publish one native preset-draft operation. The Worker operation
 * owns its single history entry; this app-side path only orders it with other
 * project mutations and publishes the returned history/configuration/plate
 * receipts. A native rejection is returned untouched so the editor can keep
 * the submitted value local and display its error inline. */
async function commitPresetDraftMutationNow(
  platform: PlatformCapabilities,
  request: PresetDraftMutationRequest,
): Promise<PresetDraftMutationResult> {
  return runProjectMutationOperation(async () => {
    const currentHistory = useHistoryNavigationStore.getState().status;
    if (currentHistory && currentHistory.revision > request.expectedRevision) {
      return {
        ok: false,
        errorCode: 'stale_revision',
        error: 'Preset draft revision was superseded by a newer project history state.',
        revision: currentHistory.revision,
      };
    }

    const result = await platform.runtime.mutatePresetDraft(request);
    if (!result.ok) return result;

    projectHistoryStatus(result.historyStatus);

    const configurationMode = useSettingsStore.getState().configurationMode;
    useSettingsStore.getState().hydrateProfileSnapshot(result.profileSnapshot);
    useSettingsStore.getState().setConfigurationMode(configurationMode);
    const scopedConfigResult = useSettingsStore.getState().applyNativeScopedConfigTransport(result.nativeScopedConfig);
    if (scopedConfigResult === 'refresh-required')
      throw new Error('native scoped configuration refresh was not accepted');

    unstable_batchedUpdates(() => {
      useFilamentSessionStore.getState().publish(result.filamentSession);
      applyPlateSessionTransforms(result.plateSession, glVolumeCollection.volumes);
      usePlateSessionStore.getState().setSnapshot(result.plateSession);
      useProjectStore.getState().recordPlateMutation(result.plateSession);
      invalidateAfterSharedConfigurationMutation(
        result.affectedPlateIds,
        platform.runtime,
        result.allPlateResultsInvalidated,
      );
    });

    return result;
  });
}

/** Share the scoped-config FIFO so a pending preset edit cannot race an
 * immediately requested slice or another configuration commit. */
export function commitPresetDraftMutation(
  platform: PlatformCapabilities,
  request: PresetDraftMutationRequest,
): Promise<PresetDraftMutationResult> {
  if (!paintingCommandAllowed()) return Promise.resolve({ ok: false, error: 'Painting command is busy', errorCode: 'invalid_request', revision: request.expectedRevision });
  const task = configurationMutationQueue.then(() => commitPresetDraftMutationNow(platform, request));
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
export function invalidateAfterSharedConfigurationMutation(
  affectedPlateIds?: readonly string[],
  runtime?: Pick<SlicerClient, 'cancel' | 'getRuntimeExecutionState'>,
  invalidateAllResults = false,
): void {
  // A native receipt with an explicitly empty affected set is a no-op. Do
  // not invalidate cached results or clear status for an unchanged mutation.
  if (affectedPlateIds !== undefined && affectedPlateIds.length === 0) return;

  // A draft project edit has no native affected receipt yet, so it represents
  // the explicit shared-configuration boundary and hides every plate result.
  const existingStatus = useSlicerStore.getState().error;
  if (affectedPlateIds !== undefined) {
    const store = useSlicerStore.getState();
    const active = store.activeSliceTarget;
    const cancel = active !== null && affectedPlateIds.includes(active.plateId) &&
      runtime?.getRuntimeExecutionState?.().threaded !== false;
    // Honor explicit invalidation semantics. Printer transitions mark their
    // complete receipt as global; ordinary scoped edits retain unrelated
    // plate results.
    if (invalidateAllResults) store.invalidateSliceResult();
    else store.invalidatePlateResults(affectedPlateIds);
    if (cancel) void runtime?.cancel().catch(() => undefined);
  } else useSlicerStore.getState().invalidateSliceResult();
  // Native configuration warnings are successful-command status, not stale
  // slice errors. Preserve the visible warning while the result projection is
  // invalidated; ordinary errors retain the existing clearing behaviour.
  if (existingStatus?.startsWith('[Warning]')) useSlicerStore.getState().setError(existingStatus);
}

/** Effective Process selection is a chronological project edit, including when
 * it separates two paint runs. The existing native history owns both roots. */
export async function selectProcessPreset(platform: PlatformCapabilities, name: string) {
  if (!paintingCommandAllowed()) return null;
  const history = await runProjectHistoryMutation(platform.runtime, 'Select Process Preset', async () => {
    const profile = await platform.runtime.selectProfile('print', name);
    if (!profile.ok) throw new Error(profile.error ?? 'Process selection failed');
    const plateSession = await platform.runtime.markSharedConfigurationMutation();
    if (!plateSession.ok) throw new Error(plateSession.error);
    const scoped = await platform.runtime.revalidateNativeScopedConfig();
    if (!scoped.ok) throw new Error(scoped.error);
    return { ok: true, profile, plateSession, nativeScopedConfig: scoped.nativeScopedConfig };
  }, null, {
    contextReceipt: (result) => ({ structure: 'preserved', activePlateId: result.plateSession.currentPlateId }),
    publish: (result) => {
      const settings = useSettingsStore.getState();
      settings.hydrateProfileSnapshot(result.profile);
      settings.applyNativeScopedConfigTransport(result.nativeScopedConfig);
      applyPlateSessionTransforms(result.plateSession, glVolumeCollection.volumes);
      usePlateSessionStore.getState().setSnapshot(result.plateSession);
      useProjectStore.getState().recordPlateMutation(result.plateSession);
      invalidateAffectedPlateResults(platform.runtime, result.plateSession.affectedPlateIds ?? []);
    },
  });
  if (!history.result.ok) throw new Error('Process selection failed');
  return history.result.profile;
}

/** Global selector action; history/scoped invalidation and preference persistence
 * are owned by the same successful mutation path as the plate editor. */
export function commitGlobalBedType(platform: PlatformCapabilities, value: string): Promise<PlateSessionMutation | null> {
  return commitScopedConfigurationMutation(platform, { version: 1, operation: 'set',
    targets: [{ scope: 'project' }], key: 'curr_bed_type', value });
}
