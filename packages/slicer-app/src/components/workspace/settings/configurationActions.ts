import { publishNozzleRepairNotice } from '../nozzleMapping/nozzleMappingNotices';
import { publishRememberedBedType, publishRememberedFilamentRack } from '@/preferences';
import { invalidateAffectedPlateResults } from '@/stores/plateResultLifecycle';
import { paintingCommandAllowed } from '../viewport/gizmo/painting/projectCommands';
import { unstable_batchedUpdates } from 'react-dom';
import { updateUserPreferences, type PlatformCapabilities } from '@orca/platform-contract';
import type {
  PrinterTransitionSuccess,
  NativeScopedConfigMutationRequest,
  NativeScopedConfigTransport,
  PresetDraftMutationRequest,
  PresetDraftMutationResult,
  PresetDraftMutationSuccess,
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
import { historyContextForStructure, projectHistoryStatus, readProjectMutationReservation, runProjectHistoryMutation, runProjectMutationOperation } from '../actions/historyMutation';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { useHistoryNavigationStore } from '@/stores/useHistoryNavigationStore';

export class CommittedEditorRefreshError extends Error {
  constructor(cause: unknown) {
    super(`The edit was committed, but its editor could not be refreshed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'CommittedEditorRefreshError';
  }
}

let configurationMutationQueue: Promise<void> = Promise.resolve();

export function commitUserPresetMutation(platform: PlatformCapabilities, request: import('@slicer/client').UserPresetRequest,
  sceneInteraction: SceneInteractionController | null) {
  const task = configurationMutationQueue.then(() => runProjectMutationOperation(async () => {
    if (!paintingCommandAllowed()) return { ok: false as const, error: 'Finish the current editing operation first' };
    const result = await platform.runtime.mutateUserPreset(request, historyContextForStructure(sceneInteraction));
    if (!result.ok) return result;
    unstable_batchedUpdates(() => {
      projectHistoryStatus(result.historyStatus);
      const settings = useSettingsStore.getState();
      const mode = settings.configurationMode;
      settings.hydrateProfileSnapshot(result.profileSnapshot);
      settings.setConfigurationMode(mode);
      settings.applyNativeScopedConfigTransport(result.nativeScopedConfig);
      useFilamentSessionStore.getState().publish(result.filamentSession);
      applyPlateSessionTransforms(result.plateSession, glVolumeCollection.volumes);
      usePlateSessionStore.getState().setSnapshot(result.plateSession);
      const project = useProjectStore.getState();
      const selections = { printer: result.profileSnapshot.printer.name, print: result.profileSnapshot.print.name };
      project.setProject(project.scope === 'project' ? { projectPresets: selections } : { systemPresets: selections });
      invalidateAfterSharedConfigurationMutation(result.plateSession.affectedPlateIds ?? [], platform.runtime, true);
    });
    return result;
  }));
  configurationMutationQueue = task.then(() => undefined, () => undefined);
  return task;
}

type ConfigurationMutationResult = PlateSessionMutationResult | {
  ok: true;
  unchanged: true;
  nativeScopedConfig: NativeScopedConfigTransport;
};

/** Share the editor FIFO with typed configuration commands. */
export function enqueueConfigurationMutation<T>(operation: () => Promise<T>): Promise<T> {
  const task = configurationMutationQueue.then(operation);
  configurationMutationQueue = task.then(() => undefined, () => undefined);
  return task;
}

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
  afterPublication?: () => Promise<void>,
): Promise<PlateSessionMutation | null> {
  let mutation: ConfigurationMutationResult | undefined;
  let previousBed: string | undefined;
  let profileSnapshot: import('@slicer/client').ProfileSnapshot | undefined;
  try {
    const history = await runProjectHistoryMutation<ConfigurationMutationResult>(
      platform.runtime,
      request.operation === 'set' || request.operation === 'set-element' ? 'Change Scoped Configuration' : 'Reset Scoped Configuration',
      async (): Promise<ConfigurationMutationResult> => {
        previousBed = useSettingsStore.getState().nativeScopedConfig.project.curr_bed_type;
        const result = await platform.runtime.mutateNativeScopedConfig(request);
        if (!result.ok) throw new Error(result.error);
        if (result.configurationStatus?.state === 'ready' && result.configurationStatus.errors.length > 0)
          throw new Error(result.configurationStatus.errors.join('; '));
        if (!result.plateSession) return { ok: true, unchanged: true, nativeScopedConfig: result.nativeScopedConfig };
        profileSnapshot = result.profileSnapshot;
        return { ...result.plateSession, nativeScopedConfig: result.nativeScopedConfig };
      },
      null,
      {
        publish: async (published, status) => {
          if (!published.ok || 'unchanged' in published) { await afterPublication?.(); return; }
          if (profileSnapshot) {
            const settings = useSettingsStore.getState();
            const mode = settings.configurationMode;
            settings.hydrateProfileSnapshot(profileSnapshot);
            settings.setConfigurationMode(mode);
            const project = useProjectStore.getState();
            const selections = { printer: profileSnapshot.printer.name, print: profileSnapshot.print.name };
            project.setProject(project.scope === 'project' ? { projectPresets: selections } : { systemPresets: selections });
          }
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
          if (request.targets.some(target => target.scope === 'project') &&
              useSettingsStore.getState().nativeScopedConfig.project.curr_bed_type !== previousBed) {
            const settings = useSettingsStore.getState();
            await publishRememberedBedType(platform.preferences, settings.selectedPrinter,
              settings.nativeScopedConfig.project.curr_bed_type);
          }
          await afterPublication?.();
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

/** Defer the editor's validity check until its existing publication reservation. */
export function readConfigurationEditor<T>(operation: () => Promise<T>) {
  return configurationMutationQueue.then(() => readProjectMutationReservation(operation));
}

/** Refresh exactly the captured owners under the same publication reservation. */
export function commitScopedEditorMutation(platform: PlatformCapabilities, request: NativeScopedConfigMutationRequest,
  targets: readonly import('@slicer/client').ScopedConfigEditorTarget[],
  publish?: (snapshot: import('@slicer/client').ScopedConfigEditorSnapshot) => void) {
  if (!paintingCommandAllowed()) return Promise.reject(new Error('Finish the current editing operation first'));
  const task = configurationMutationQueue.then(async () => {
    let editor: import('@slicer/client').ScopedConfigEditorSnapshotResult | undefined;
    let accepted = false;
    try {
      await commitScopedConfigurationMutationNow(platform, request, async () => {
        accepted = true;
        editor = await platform.runtime.getScopedConfigEditor({ version: 1, targets });
        if (!editor.ok) throw new Error(editor.error);
        publish?.(editor);
      });
    } catch (error) { if (accepted) throw new CommittedEditorRefreshError(error); throw error; }
    if (!editor) throw new Error('Scoped configuration operation was not published');
    if (!editor.ok) throw new Error(editor.error);
    return editor;
  });
  configurationMutationQueue = task.then(() => undefined, () => undefined);
  return task;
}

/** Keep the typed Print refresh within the same command's publication lease. */
export function commitPrintConfigurationMutation(platform: PlatformCapabilities, request: NativeScopedConfigMutationRequest,
  publish?: (snapshot: import('@slicer/client').ConfigEditorSnapshot) => void) {
  if (!paintingCommandAllowed()) return Promise.reject(new Error('Finish the current editing operation first'));
  const task = configurationMutationQueue.then(async () => {
    let editor: import('@slicer/client').ConfigEditorSnapshotResult | undefined;
    let accepted = false;
    try {
      await commitScopedConfigurationMutationNow(platform, request, async () => {
        accepted = true;
        editor = await platform.runtime.getPrintConfigEditor();
        if (!editor.ok) throw new Error(editor.error);
        publish?.(editor);
      });
    } catch (error) { if (accepted) throw new CommittedEditorRefreshError(error); throw error; }
    if (!editor) throw new Error('Print configuration operation was not published');
    if (!editor.ok) throw new Error(editor.error);
    return editor;
  });
  configurationMutationQueue = task.then(() => undefined, () => undefined);
  return task;
}

/** Native commit succeeded; an application projection refresh failed. */
export class CommittedPresetDraftProjectionError extends Error {
  constructor(readonly receipt: PresetDraftMutationSuccess, cause: unknown) {
    super(`The edit was committed, but its displayed state could not be refreshed: ${errorText(cause)}. Close and reopen the editor to continue.`);
    this.name = 'CommittedPresetDraftProjectionError';
  }
}

/** Commit and publish one native preset-draft operation. The Worker operation
 * owns its single history entry; this app-side path only orders it with other
 * project mutations and publishes the returned history/configuration/plate
 * receipts. A native rejection is returned untouched so the editor can keep
 * the submitted value local and display its error inline. */
async function commitPresetDraftMutationNow(
  platform: PlatformCapabilities,
  request: PresetDraftMutationRequest,
  sceneInteraction: SceneInteractionController | null,
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

    const result = await platform.runtime.mutatePresetDraft(request, historyContextForStructure(sceneInteraction));
    if (!result.ok) return result;

    // Check the actual base before projectHistoryStatus's synchronous filament
    // subscription advances its optimistic token to the committed revision.
    const settingsBase = useSettingsStore.getState();
    const filamentBase = useFilamentSessionStore.getState().snapshot;
    const canRetain = result.projectionKind === 'ordinary-edit' && settingsBase.printerPicker !== null &&
      !settingsBase.nativeScopedConfigRefreshRequired &&
      settingsBase.nativeScopedConfigRevision === result.revisionBefore &&
      settingsBase.selectedPrinter === result.profileSnapshot.printer.name &&
      settingsBase.selectedPrint === result.profileSnapshot.print.name &&
      settingsBase.printers.some(preset => preset.name === settingsBase.selectedPrinter) &&
      settingsBase.prints.some(preset => preset.name === settingsBase.selectedPrint) &&
      filamentBase !== null && filamentBase.assignments !== undefined &&
      filamentBase.revisions.session === result.revisionBefore &&
      filamentBase.revisions.project === result.revisionBefore &&
      filamentBase.slots.length === result.filamentSession.slots.length &&
      filamentBase.slots.every((slot, index) => slot.logicalId === result.filamentSession.slots[index].logicalId);
    const configurationMode = settingsBase.configurationMode;
    let publicationError: CommittedPresetDraftProjectionError | null = null;
    try {
      let refreshed: Awaited<ReturnType<typeof platform.runtime.getProfileSnapshot>> | undefined;
      let refreshedFilament: Awaited<ReturnType<typeof platform.runtime.getFilamentSessionSnapshot>> | undefined;
      if (result.projectionKind === 'ordinary-edit' && !canRetain) {
        // Exceptional recovery only. Normal edits retain the known arrays and
        // references without another Worker read or a client-side full payload.
        [refreshed, refreshedFilament] = await Promise.all([
          platform.runtime.getProfileSnapshot(), platform.runtime.getFilamentSessionSnapshot(),
        ]);
        if (!refreshed.ok) throw new Error(refreshed.error);
        if (!refreshedFilament.ok) throw new Error(refreshedFilament.error);
        if (refreshedFilament.revisions.session !== result.revisionAfter ||
            refreshedFilament.revisions.project !== result.revisionAfter ||
            refreshed.printer.name !== result.profileSnapshot.printer.name ||
            refreshed.print.name !== result.profileSnapshot.print.name)
          throw new Error('preset projection refresh was superseded');
      }
      projectHistoryStatus(result.historyStatus);
      unstable_batchedUpdates(() => {
        const settings = useSettingsStore.getState();
        if (result.projectionKind === 'full') {
          settings.hydrateProfileSnapshot(result.profileSnapshot);
          useFilamentSessionStore.getState().publish(result.filamentSession);
        } else if (canRetain) {
          settings.applyProfileOrdinaryEdit(result.profileSnapshot);
          useFilamentSessionStore.getState().applyOrdinaryEdit(result.filamentSession, filamentBase!);
        } else {
          if (!refreshed?.ok || !refreshedFilament?.ok) throw new Error('preset projection refresh is unavailable');
          settings.hydrateProfileSnapshot(refreshed);
          useFilamentSessionStore.getState().publish(refreshedFilament);
        }
        settings.setConfigurationMode(configurationMode);
        const scoped = settings.applyNativeScopedConfigTransport(result.nativeScopedConfig);
        if (scoped !== 'applied' && useSettingsStore.getState().nativeScopedConfigRevision !== result.revisionAfter)
          throw new Error('native scoped configuration refresh was not accepted');
        publishNozzleRepairNotice(settingsBase.nativeScopedConfig, useSettingsStore.getState().nativeScopedConfig,
          (useSettingsStore.getState().values.nozzle_diameter?.split(',').length ?? 0));
      });
    } catch (error) {
      publicationError = new CommittedPresetDraftProjectionError(result, error);
      // Publish the native commit and complete receipts even if recovery fails.
      // Retain any complete older projection, explicitly mark it for resync,
      // and never invent empty references or report a native rejection.
      projectHistoryStatus(result.historyStatus);
      useSettingsStore.getState().applyNativeScopedConfigTransport(result.nativeScopedConfig);
      useSettingsStore.setState({ nativeScopedConfigRefreshRequired: true });
      useFilamentSessionStore.setState({ rejected: publicationError.message });
    }
    unstable_batchedUpdates(() => {
      applyPlateSessionTransforms(result.plateSession, glVolumeCollection.volumes);
      usePlateSessionStore.getState().setSnapshot(result.plateSession);
      const project = useProjectStore.getState();
      const selections = { printer: result.profileSnapshot.printer.name, print: result.profileSnapshot.print.name };
      project.setProject(project.scope === 'project'
        ? { projectPresets: selections } : { systemPresets: selections });
      invalidateAfterSharedConfigurationMutation(
        result.affectedPlateIds, platform.runtime, result.allPlateResultsInvalidated,
      );
    });
    if (publicationError) {
      useSlicerStore.getState().setError(publicationError.message);
      throw publicationError;
    }

    return result;
  });
}

/** Share the scoped-config FIFO so a pending preset edit cannot race an
 * immediately requested slice or another configuration commit. */
export function commitPresetDraftMutation(
  platform: PlatformCapabilities,
  request: PresetDraftMutationRequest,
  sceneInteraction: SceneInteractionController | null,
): Promise<PresetDraftMutationResult> {
  if (!paintingCommandAllowed()) return Promise.resolve({ ok: false, error: 'Painting command is busy', errorCode: 'invalid_request', revision: request.expectedRevision });
  const task = configurationMutationQueue.then(() => commitPresetDraftMutationNow(platform, request, sceneInteraction));
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
      settings.enterPrintPreset();
      applyPlateSessionTransforms(result.plateSession, glVolumeCollection.volumes);
      usePlateSessionStore.getState().setSnapshot(result.plateSession);
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

export function publishPrinterTransition(platform: PlatformCapabilities, transition: PrinterTransitionSuccess) {
  // This command already committed the single native history entry.
  // Publish its receipt directly; do not issue a second rack edit,
  // revision bump, profile read, or scoped-config revalidation.
  unstable_batchedUpdates(() => {
    const status = projectHistoryStatus(transition.historyStatus);
    if (status.revision === transition.historyStatus.revision) {
      const previousScoped = useSettingsStore.getState().nativeScopedConfig;
      const configurationMode = useSettingsStore.getState().configurationMode;
      useSettingsStore.getState().hydrateProfileSnapshot(transition.profileSnapshot);
      if (transition.mutation.kind === 'set-toolhead-diameter' || transition.mutation.kind === 'set-project-flow')
        useSettingsStore.getState().setConfigurationMode(configurationMode);
      const scoped = useSettingsStore.getState().applyNativeScopedConfigTransport(
        transition.nativeScopedConfig,
      );
      if (scoped === 'refresh-required')
        throw new Error('Printer transition scoped configuration receipt was not accepted');
      publishNozzleRepairNotice(previousScoped, useSettingsStore.getState().nativeScopedConfig,
        (useSettingsStore.getState().values.nozzle_diameter?.split(',').length ?? 0));
      useFilamentSessionStore.getState().publish(transition.filamentSession);
      applyPlateSessionTransforms(transition.plateSession, glVolumeCollection.volumes);
      usePlateSessionStore.getState().setSnapshot(transition.plateSession);
      const project = useProjectStore.getState();
      const selections = {
        printer: transition.profileSnapshot.printer.name,
        print: transition.profileSnapshot.print.name,
      };
      project.setProject(project.scope === 'project'
        ? { projectPresets: selections } : { systemPresets: selections });
      invalidateAfterSharedConfigurationMutation(
        transition.mutation.affectedPlateIds, platform.runtime,
        transition.mutation.allPlateResultsInvalidated,
      );
    }
  });

  }

export async function rememberPrinterTransition(platform: PlatformCapabilities, transition: PrinterTransitionSuccess) {
  // Rack memory is an independent user preference, not part of the
  // native project-history frame. Publish only the normalized rack
  // returned by a successful native transition, even in project scope.
  await publishRememberedFilamentRack(
    platform.preferences, transition.profileSnapshot.printer.name, transition.filamentSession,
  );
  await publishRememberedBedType(platform.preferences, transition.profileSnapshot.printer.name,
    transition.nativeScopedConfig.snapshot.project.curr_bed_type);
  const project = useProjectStore.getState();
  if (project.scope !== 'project') {
    try {
      await updateUserPreferences(platform.preferences, prefs => ({ ...prefs, selectedProfiles: {
        printer: transition.profileSnapshot.printer.name,
        print: transition.profileSnapshot.print.name,
      } }));
    } catch (error) {
      console.error('preset preference save failed; keeping resolved session state', error);
    }
  }
  }
