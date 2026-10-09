import type { PlatformCapabilities } from '@orca/platform-contract';
import type { ProfileActivationApplicationResult } from '@slicer/client';
import { useSettingsStore } from './stores/useSettingsStore';
import { useFilamentSessionStore } from './stores/useFilamentSessionStore';
import { usePlateSessionStore } from './stores/usePlateSessionStore';
import { useProjectStore, projectPresetSelections } from './stores/useProjectStore';
import { projectHistoryStatus } from './history/projectHistoryStatus';
import { establishInitialProjectHistorySaved } from './components/workspace/actions/historyMutation';
import { invalidateAffectedPlateResults } from './stores/plateResultLifecycle';
import { applyPlateSessionTransforms } from './components/workspace/actions/syncModelTransforms';
import { glVolumeCollection } from './components/workspace/viewport/GLVolume';
import { publishRememberedFilamentRack, publishRememberedBedType } from './preferences';
import { readSceneDeltaProjection } from './components/workspace/viewport/sceneDeltaProjection';
import { useObjectListStore } from './components/workspace/objectList/useObjectListStore';
import { updateUserPreferences } from '@orca/platform-contract';

type AppliedActivation = Extract<ProfileActivationApplicationResult, { ok: true }>;
/** Project the authoritative activation receipt and establish the initial setup checkpoint. */
export async function publishSetupWizardApplication(platform: PlatformCapabilities, result: AppliedActivation,
  mode: 'initial-setup' | 'existing-project'): Promise<void> {
  // First-use defaults establish the initial empty project, rather than edit
  // an admitted project. Keep the native checkpoint authoritative for all UI.
  const historyStatus = mode === 'initial-setup' ? await establishInitialProjectHistorySaved(platform.runtime) : result.historyStatus;
  if (result.configurationChanged && glVolumeCollection.volumes.length) {
    const structure = useObjectListStore.getState().structure;
    const projection = await readSceneDeltaProjection(platform.runtime, { version: 1, objectIds: structure.map(object => object.id), objectOrder: structure.map(object => object.id), volumeIds: [], instanceIds: [], plateIds: [] }, structure, glVolumeCollection.volumes);
    projection.apply();
    useObjectListStore.getState().setStructure(projection.structure);
    glVolumeCollection.patch(projection.volumes, useSettingsStore.getState().modelRevision);
  }
  applyPlateSessionTransforms({ instanceTransforms: result.plateSession.instanceTransforms ?? [] }, glVolumeCollection.volumes);
  usePlateSessionStore.getState().setSnapshot(result.plateSession);
  useProjectStore.getState().recordPlateMutation(result.plateSession);
  useSettingsStore.getState().hydrateProfileSnapshot(result.profileSnapshot);
  useSettingsStore.getState().applyNativeScopedConfigTransport(result.nativeScopedConfig);
  useFilamentSessionStore.getState().publish(result.filamentSession);
  projectHistoryStatus(historyStatus);
  const selections = projectPresetSelections(result.profileSnapshot);
  useProjectStore.getState().setProject(useProjectStore.getState().scope === 'project'
    ? { projectPresets: selections } : { systemPresets: selections });
  if (result.configurationChanged) invalidateAffectedPlateResults(platform.runtime, result.plateSession.plates.map(plate => plate.plateId));
  // These mirrors are best effort after successful publication and never replace activation.
  try { await updateUserPreferences(platform.preferences, current => ({ ...current, selectedProfiles: selections })); }
  catch (error) { console.warn('setup selection preference save failed', error); }
  await publishRememberedFilamentRack(platform.preferences, selections.printer, result.filamentSession);
  const bed = result.profileSnapshot.project_config?.curr_bed_type;
  if (typeof bed === 'string') await publishRememberedBedType(platform.preferences, selections.printer, bed);
}
