import type { PlatformCapabilities } from '@orca/platform-contract';
import type { NozzleMappingChange, NozzleMappingSnapshot } from '@slicer/client';
import { unstable_batchedUpdates } from 'react-dom';
import { publishRememberedNozzleCapacities } from '@/preferences';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { projectFilamentPlateInputRevisions } from '@/stores/useFilamentSessionStore';
import { historyContextForStructure, projectHistoryStatus, runProjectMutationOperation } from '../actions/historyMutation';
import { enqueueConfigurationMutation, invalidateAfterSharedConfigurationMutation } from '../settings/configurationActions';
import { paintingCommandAllowed } from '../viewport/gizmo/painting/projectCommands';

/** Capture both revisions in the editor; queueing never silently retargets an
 * edit to newer inputs or a different selected Plate. */
export function commitNozzleMapping(
  platform: PlatformCapabilities, snapshot: NozzleMappingSnapshot,
  revision: number, change: NozzleMappingChange,
) {
  return enqueueConfigurationMutation(() => runProjectMutationOperation(async () => {
    if (!paintingCommandAllowed()) throw new Error('Finish the current editing operation first');
    const printer = useSettingsStore.getState().selectedPrinter;
    const result = await platform.runtime.mutateNozzleMapping({
      plateId: snapshot.plateId, plateRevision: snapshot.revision, revision, change,
    }, historyContextForStructure());
    if (!result.ok) throw new Error(result.error);
    unstable_batchedUpdates(() => {
      projectHistoryStatus(result.historyStatus);
      if (result.nativeScopedConfig)
        useSettingsStore.getState().applyNativeScopedConfigTransport(result.nativeScopedConfig);
      if (result.plateSession) {
        invalidateAfterSharedConfigurationMutation(result.plateSession.affectedPlateIds, platform.runtime);
        usePlateSessionStore.getState().setSnapshot(result.plateSession);
        projectFilamentPlateInputRevisions(result.historyStatus.revision, result.plateSession.inputRevisions);
      }
    });
    // These commands change Plate maps/mode or feeder capacity, never rack
    // contents, assignments, routing or flushing values. History publication
    // advances the retained rack's command token without changing its identity.
    if (result.changed && change.kind === 'capacity')
      await publishRememberedNozzleCapacities(platform.preferences, printer, result.snapshot);
    return result;
  }));
}
