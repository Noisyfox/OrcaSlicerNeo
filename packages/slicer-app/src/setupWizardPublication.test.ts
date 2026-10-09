import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_USER_PREFERENCES, type UserPreferences, type UserPreferencesRepository, type PlatformCapabilities } from '@orca/platform-contract';
import { createClient, createMockModule, MOCK_PROFILE_ACTIVATION } from '@slicer/client';
import { completeSetupWizard } from './setupWizard';
import { publishSetupWizardApplication } from './setupWizardPublication';
import { useSlicerStore } from './stores/useSlicerStore';
import { useSettingsStore } from './stores/useSettingsStore';
import { useProjectStore } from './stores/useProjectStore';
import { usePlateSessionStore } from './stores/usePlateSessionStore';
import { useHistoryNavigationStore } from './stores/useHistoryNavigationStore';
import { useFilamentSessionStore } from './stores/useFilamentSessionStore';
import { glVolumeCollection } from './components/workspace/viewport/GLVolume';
beforeEach(() => {
  useProjectStore.getState().reset(); useSettingsStore.getState().resetNativeScopedConfig();
  useHistoryNavigationStore.getState().reset(); usePlateSessionStore.getState().reset();
  useSlicerStore.setState(useSlicerStore.getInitialState()); glVolumeCollection.clear();
});
async function fixture(initialSetup = false) {
  const runtime = createClient(async () => createMockModule()); await runtime.init(initialSetup ? null : MOCK_PROFILE_ACTIVATION); await runtime.openSetupWizardCatalogue();
  let saved: UserPreferences = { ...structuredClone(DEFAULT_USER_PREFERENCES), profileActivation: MOCK_PROFILE_ACTIVATION };
  const preferences: UserPreferencesRepository = { load: async () => saved, save: async next => { saved = next; } };
  const targetActivation = initialSetup ? { models: [MOCK_PROFILE_ACTIVATION.models[1]], filaments: MOCK_PROFILE_ACTIVATION.filaments } : MOCK_PROFILE_ACTIVATION;
  const result = await completeSetupWizard(runtime, preferences, targetActivation);
  if (!result.ok) throw new Error(result.error);
  const platform = { runtime, preferences } as unknown as PlatformCapabilities;
  const plateId = result.plateSession.currentPlateId, inputStamp = result.plateSession.inputRevisions![plateId];
  const receipt = { plateId, inputStamp, resultId: 42 };
  const plateResults = { [plateId]: { target: { plateId, inputRevision: inputStamp }, receipt, warnings: [], summary: {} } };
  useSlicerStore.setState({ status: 'done', plateResults: plateResults as never, sliceTarget: { plateId, inputRevision: inputStamp },
    resultExported: true, preview: { ...useSlicerStore.getInitialState().preview, resultId: 42, maxMove: 12 } });
  return { platform, result, saved: () => saved, plateResults, preview: useSlicerStore.getState().preview };
}
describe('setup authoritative receipt publication', () => {
  it('first-use defaults establish the native clean empty-project checkpoint before publication', async () => {
    const f = await fixture(true);
    expect(f.result.configurationChanged).toBe(true); expect(f.result.historyStatus.dirty).toBe(true);
    await publishSetupWizardApplication(f.platform, f.result, 'initial-setup');
    const status = await f.platform.runtime.getHistoryStatus();
    expect(status).toMatchObject({ dirty: false, canUndo: false, canRedo: false });
    expect(useHistoryNavigationStore.getState().status).toEqual(status);
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, hasContent: false });
  });
  it('candidate-only keeps a clean existing project and exact result receipts clean', async () => {
    const f = await fixture(); f.result.configurationChanged = false;
    f.result.historyStatus = { ...f.result.historyStatus, dirty: false };
    useProjectStore.getState().setProject({ dirty: false, hasContent: true });
    const markSaved = vi.spyOn(f.platform.runtime, 'markHistorySaved');
    await publishSetupWizardApplication(f.platform, f.result, 'existing-project');
    expect(markSaved).not.toHaveBeenCalled();
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, hasContent: true });
    expect(useSlicerStore.getState().plateResults).toBe(f.plateResults);
    expect(useSlicerStore.getState().preview).toBe(f.preview);
    expect(useSlicerStore.getState().resultExported).toBe(true);
  });
  it('candidate-only clears history while retaining exact dirty, slices, preview and export receipt identity', async () => {
    const f = await fixture(); f.result.configurationChanged = false;
    f.result.historyStatus = { ...f.result.historyStatus, dirty: true, canUndo: false, canRedo: false };
    useProjectStore.getState().setProject({ dirty: true, hasContent: true, projectName: 'Retained', scope: 'project' });
    await publishSetupWizardApplication(f.platform, f.result, 'existing-project');
    expect(useSlicerStore.getState().plateResults).toBe(f.plateResults);
    expect(useSlicerStore.getState().preview).toBe(f.preview);
    expect(useSlicerStore.getState().resultExported).toBe(true);
    expect(useProjectStore.getState()).toMatchObject({ dirty: true, projectName: 'Retained', hasContent: true, scope: 'project' });
    expect(useHistoryNavigationStore.getState().status).toBe(f.result.historyStatus);
    expect(useHistoryNavigationStore.getState().status!.canUndo).toBe(false);
    expect(useFilamentSessionStore.getState().snapshot).toBe(f.result.filamentSession);
    expect(usePlateSessionStore.getState().snapshot).toBe(f.result.plateSession);
    expect(f.saved().profileActivation).toEqual(MOCK_PROFILE_ACTIVATION);
    expect(f.saved().selectedProfiles.printer).toBe(f.result.profileSnapshot.printer.name);
  });
  it('changed effective config invalidates applicable slice/preview/export and projects native dirty', async () => {
    const f = await fixture(); f.result.configurationChanged = true;
    f.result.historyStatus = { ...f.result.historyStatus, dirty: true };
    await publishSetupWizardApplication(f.platform, f.result, 'existing-project');
    expect(useSlicerStore.getState()).toMatchObject({ plateResults: {}, status: 'idle', resultExported: false, preview: { resultId: null } });
    expect(useProjectStore.getState().dirty).toBe(true);
    expect(useSettingsStore.getState().selectedPrinter).toBe(f.result.profileSnapshot.printer.name);
    expect(useSettingsStore.getState().nativeScopedConfig).toEqual(f.result.nativeScopedConfig.kind === 'full' ? f.result.nativeScopedConfig.snapshot : undefined);
  });
});
