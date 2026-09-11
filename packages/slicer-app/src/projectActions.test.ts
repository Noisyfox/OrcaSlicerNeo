import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformCapabilities, ProjectInput, UserPreferences } from '@orca/platform-contract';
import type { FilamentSessionSnapshot, PlateSessionMutation, ProfileSnapshot, ProjectLoadResult } from '@slicer/client';
import { useProjectStore } from './stores/useProjectStore';
import { useSettingsStore } from './stores/useSettingsStore';
import { useSlicerStore } from './stores/useSlicerStore';
import { usePlateSessionStore } from './stores/usePlateSessionStore';
import { useFilamentSessionStore } from './stores/useFilamentSessionStore';
import { glVolumeCollection } from './components/workspace/viewport/GLVolume';
import { importProjectGeometry, newProject, openProject, openProjectInputs, saveProject, sortProjectInputs } from './projectActions';

const input: ProjectInput = { displayName: 'Robot.3mf', bytes: new Uint8Array([80, 75, 3, 4]) };
const snapshot: ProfileSnapshot = {
  ok: true,
  printers: [{ name: 'Project printer', is_visible: true, is_default: false, vendor_id: '', model: '', variant: '', selected: true }],
  prints: [{ name: 'Project process', is_visible: true, is_default: false, vendor_id: '', model: '', variant: '', selected: true }],
  filamentCatalog: [{ name: 'Project filament', is_visible: true, is_default: false, vendor_id: '', model: '', variant: '' }],
  printer: { name: 'Project printer', idx: 0 }, print: { name: 'Project process', idx: 0 },
};
const freshPlateSession: PlateSessionMutation = {
  ok: true,
  version: 1,
  currentPlateId: 'new-plate-1',
  plates: [{ plateId: 'new-plate-1', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1' }],
  instanceTransforms: [],
};
function filamentSnapshot(revision: number): FilamentSessionSnapshot {
  return {
    ok: true, version: 1,
    slots: [{ slot: 1, preset: { id: 'pla', name: `PLA ${revision}` }, colour: { effective: '#112233', provenance: 'preset' } }],
    mappings: { filament: [1], volume: [0], nozzle: [1], filament2: [1], physicalExtruder: [0] },
    flushing: { matrix: [0], vector: [0], matrixDimension: 1, planeCount: 1, source: 'native' },
    capabilities: { minSlots: 1, maxSlots: 8, nozzleCount: 1, flexible: true, canAdd: true, canDelete: true, canMerge: true },
    assignments: { objects: [], parts: [], modifiers: [] },
    revisions: { session: revision, project: revision, result: 0, plates: {} },
    status: { state: 'ready', error: null },
  };
}
function platformFor(load: Record<string, unknown> = {}) {
  const runtime = {
    loadProject: vi.fn(async () => ({ ok: true, objects: 1, instances: 1, mode: 'project' as const, compatibility: 'bambu' as const, projectSettingsAvailable: true, presetSnapshot: snapshot, ...load })),
    importProjectGeometry: vi.fn(async () => ({ ok: true, objects: 2, instances: 2, mode: 'geometry-only' as const, compatibility: 'generic' as const, projectSettingsAvailable: false })),
    clearModel: vi.fn(async () => ({ ok: true })),
    exportProject: vi.fn(async () => ({ ok: true, path: '/tmp/project.3mf', bytes: new Uint8Array([1, 2]) })),
    getProfileSnapshot: vi.fn(async () => snapshot),
    selectProfile: vi.fn(async () => snapshot),
    getFilamentSessionSnapshot: vi.fn(async () => filamentSnapshot(0)),
    applyRememberedFilamentRack: vi.fn(async () => filamentSnapshot(1)),
    resetHistory: vi.fn(async () => null),
    cancel: vi.fn(async () => ({ ok: true })),
    runProjectHistoryTransaction: vi.fn(async <T>(
      _label: string,
      _category: 'project' | 'context',
      _before: unknown,
      mutation: (transactionId: string) => Promise<T>,
      _after: unknown | (() => unknown | Promise<unknown>),
    ) => ({ result: await mutation('tx-1'), status: {} as never })),
  };
  const projects = {
    open: vi.fn(async () => ({ status: 'ok' as const, input })),
    save: vi.fn(async () => ({ status: 'ok' as const })),
    saveAs: vi.fn(async () => ({ status: 'ok' as const })),
  };
  const preferences = { load: vi.fn(async () => ({ version: 1 as const, selectedProfiles: {}, ui: {} })), save: vi.fn(async () => {}) };
  return { runtime, projects, preferences, platform: { runtime, projects, preferences } as unknown as PlatformCapabilities };
}
function addPreflight(runtime: ReturnType<typeof platformFor>['runtime'], result: ProjectLoadResult, commitResult: ProjectLoadResult = result) {
  const preflightRuntime = runtime as typeof runtime & {
    preflightProject: ReturnType<typeof vi.fn>;
    commitProjectPreflight: ReturnType<typeof vi.fn>;
    cancelProjectPreflight: ReturnType<typeof vi.fn>;
  };
  preflightRuntime.preflightProject = vi.fn(async () => result);
  preflightRuntime.commitProjectPreflight = vi.fn(async () => commitResult);
  preflightRuntime.cancelProjectPreflight = vi.fn(async () => ({ ok: true }));
  return preflightRuntime;
}

describe('transactional project actions', () => {
  beforeEach(() => {
    useProjectStore.getState().reset();
    usePlateSessionStore.getState().reset();
    glVolumeCollection.clear();
    useSettingsStore.setState({ modelLoaded: false, selectedPrinter: 'System printer', selectedPrint: 'System process', values: {} });
    useFilamentSessionStore.getState().reset();
    useSlicerStore.getState().invalidateSliceResult();
  });

  it('applies every load behaviour and asks only when required', async () => {
    const all = platformFor();
    await openProject(all.platform, { loadBehaviour: 'load_all' });
    expect(all.runtime.loadProject).toHaveBeenCalled();

    useProjectStore.getState().reset(); useSettingsStore.setState({ modelLoaded: true });
    const relevant = platformFor(); const choose = vi.fn(() => 'geometry-only' as const);
    await openProject(relevant.platform, { loadBehaviour: 'ask_when_relevant', chooseLoad: choose });
    expect(choose).toHaveBeenCalled(); expect(relevant.runtime.importProjectGeometry).toHaveBeenCalled();

    useProjectStore.getState().reset(); const always = platformFor();
    const cancelled = await openProject(always.platform, { loadBehaviour: 'always_ask' });
    expect(cancelled.status).toBe('cancelled'); expect(always.runtime.loadProject).not.toHaveBeenCalled();

    const geometry = platformFor();
    await openProject(geometry.platform, { loadBehaviour: 'load_geometry_only' });
    expect(geometry.runtime.importProjectGeometry).toHaveBeenCalled();
  });

  it('replaces the project after explicit open even when settings fallback is needed', async () => {
    const { platform } = platformFor({ compatibility: 'generic', projectSettingsAvailable: false });
    useSettingsStore.setState({ modelLoaded: true });
    useProjectStore.getState().setProject({ dirty: true, hasContent: true });
    const result = await openProject(platform, { loadBehaviour: 'load_all', decideDirty: () => 'dont-save' });
    expect(result.status).toBe('ok');
    expect(useProjectStore.getState()).toMatchObject({ projectName: 'Robot', dirty: false, scope: 'project', hasContent: true });
    expect(useProjectStore.getState().notices[0]?.kind).toBe('compatibility-fallback');
  });

  it('commits the native load response without a second snapshot read', async () => {
    const { platform, runtime } = platformFor();
    runtime.getProfileSnapshot.mockResolvedValue({ ok: false, error: 'late snapshot read failed' } as never);
    const result = await openProject(platform, { loadBehaviour: 'load_all' });
    expect(result.status).toBe('ok');
    expect(runtime.getProfileSnapshot).not.toHaveBeenCalled();
    expect(useProjectStore.getState()).toMatchObject({ projectName: 'Robot', scope: 'project', dirty: false });
  });

  it('auto-commits a clean preflight without opening a confirmation dialog', async () => {
    const { platform, runtime } = platformFor();
    const result: ProjectLoadResult = { ok: true, objects: 1, instances: 1, mode: 'project', compatibility: 'bambu', projectSettingsAvailable: true, preflightToken: 'clean-token', presetSnapshot: snapshot,
      embeddedPresetWarnings: { present: false, count: 0, printerCount: 0, processCount: 0, filamentCount: 0, modifiedPrinterGcode: false, modifiedFilamentGcode: false, missingSystemPreset: false, requiresConfirmation: false, filamentSlotChanges: [] } };
    const preflight = addPreflight(runtime, result);
    const confirm = vi.fn(() => true);
    expect((await openProject(platform, { loadBehaviour: 'load_all', confirmProjectLoad: confirm })).status).toBe('ok');
    expect(confirm).not.toHaveBeenCalled();
    expect(preflight.commitProjectPreflight).toHaveBeenCalledWith('clean-token', expect.any(Function));
    expect(preflight.cancelProjectPreflight).not.toHaveBeenCalled();
  });

  it('shows warning confirmation and leaves project state untouched on rejection', async () => {
    const { platform, runtime } = platformFor();
    useProjectStore.getState().setProject({ projectName: 'Prior', hasContent: true, dirty: true });
    const result: ProjectLoadResult = { ok: true, objects: 1, instances: 1, mode: 'project', compatibility: 'bambu', projectSettingsAvailable: true, preflightToken: 'warning-token', presetSnapshot: snapshot,
      embeddedPresetWarnings: { present: true, count: 1, printerCount: 1, processCount: 0, filamentCount: 0, modifiedPrinterGcode: false, modifiedFilamentGcode: false, missingSystemPreset: false, requiresConfirmation: true, filamentSlotChanges: [{ slot: 1, before: 'A', after: 'B', reason: 'native-compatibility' }] } };
    const preflight = addPreflight(runtime, result);
    const before = useProjectStore.getState();
    const cancelled = await openProject(platform, { loadBehaviour: 'load_all', decideDirty: () => 'dont-save', confirmProjectLoad: () => false });
    expect(cancelled.status).toBe('cancelled');
    expect(preflight.cancelProjectPreflight).toHaveBeenCalledWith('warning-token');
    expect(preflight.commitProjectPreflight).not.toHaveBeenCalled();
    expect(useProjectStore.getState()).toMatchObject({ projectName: before.projectName, hasContent: before.hasContent, dirty: before.dirty });
  });

  it('cleans the pending token when confirmation throws or commit fails', async () => {
    const thrown = platformFor();
    const warning: ProjectLoadResult = { ok: true, objects: 1, instances: 1, mode: 'project', compatibility: 'bambu', projectSettingsAvailable: true, preflightToken: 'throw-token', presetSnapshot: snapshot,
      embeddedPresetWarnings: { present: true, count: 1, printerCount: 1, processCount: 0, filamentCount: 0, modifiedPrinterGcode: false, modifiedFilamentGcode: false, missingSystemPreset: false, requiresConfirmation: true } };
    const thrownRuntime = addPreflight(thrown.runtime, warning);
    const confirmationError = new Error('dialog closed');
    expect((await openProject(thrown.platform, { loadBehaviour: 'load_all', confirmProjectLoad: () => { throw confirmationError; } })).status).toBe('failed');
    expect(thrownRuntime.cancelProjectPreflight).toHaveBeenCalledWith('throw-token');

    const failed = platformFor();
    const failedResult = { ...warning, preflightToken: 'commit-token' };
    const failedRuntime = addPreflight(failed.runtime, failedResult, { ok: false, error: 'commit failed', objects: 0, instances: 0 });
    const failedResultAction = await openProject(failed.platform, { loadBehaviour: 'load_all', confirmProjectLoad: () => true });
    expect(failedResultAction.status).toBe('failed');
    expect(failedRuntime.cancelProjectPreflight).toHaveBeenCalledWith('commit-token');
  });

  it('refreshes the filament mirror after open-project history reset', async () => {
    const { platform, runtime } = platformFor();
    const beforeReset = filamentSnapshot(4);
    const afterReset = filamentSnapshot(9);
    useFilamentSessionStore.setState({ snapshot: beforeReset, rejected: null });
    runtime.getFilamentSessionSnapshot.mockResolvedValue(afterReset);
    runtime.resetHistory.mockImplementation(async () => {
      // The refresh must not run against the pre-reset history fence.
      expect(useFilamentSessionStore.getState().snapshot).toBe(beforeReset);
      return null;
    });

    const result = await openProject(platform, { loadBehaviour: 'load_all' });

    expect(result.status).toBe('ok');
    expect(runtime.resetHistory.mock.invocationCallOrder[0]).toBeLessThan(runtime.getFilamentSessionSnapshot.mock.invocationCallOrder[0]);
    expect(useFilamentSessionStore.getState().snapshot?.revisions.session).toBe(afterReset.revisions.session);
  });

  it('subscribes the project operation to native load progress', async () => {
    const { platform, runtime } = platformFor();
    const result = await openProject(platform, { loadBehaviour: 'load_all' });
    expect(result.status).toBe('ok');
    const onProgress = (runtime.loadProject.mock.calls as unknown[][])[0]?.[3] as ((percent: number, message: string) => void) | undefined;
    expect(onProgress).toEqual(expect.any(Function));
    onProgress?.(42, 'Reading project settings');
    expect(useProjectStore.getState().operation).toMatchObject({ phase: 'loading', progress: 42, message: 'Reading project settings' });
  });

  it('geometry import never replaces active settings and makes the session dirty', async () => {
    const { platform } = platformFor();
    useSettingsStore.setState({ modelLoaded: true, selectedPrinter: 'Current printer', selectedPrint: 'Current process', values: { layer_height: '0.2' } });
    await importProjectGeometry(platform, input);
    expect(useSettingsStore.getState()).toMatchObject({ selectedPrinter: 'Current printer', selectedPrint: 'Current process', values: { layer_height: '0.2' } });
    expect(useProjectStore.getState()).toMatchObject({ projectName: 'Untitled', dirty: true, hasContent: true });
  });

  it('cancelled/failed saves leave the clean baseline and dirty state untouched', async () => {
    const cancelled = platformFor(); cancelled.projects.save.mockResolvedValue({ status: 'cancelled' } as never);
    useProjectStore.getState().setProject({ hasContent: true, dirty: true, projectName: 'Robot' });
    expect((await saveProject(cancelled.platform)).status).toBe('cancelled');
    expect(useProjectStore.getState().dirty).toBe(true);

    const failed = platformFor(); failed.runtime.exportProject.mockResolvedValue({ ok: false, path: '', bytes: new Uint8Array(), error: 'export failed' } as never);
    expect((await saveProject(failed.platform)).status).toBe('failed');
    expect(useProjectStore.getState().dirty).toBe(true);
  });

  it('Save then New restores the saved global preset selection', async () => {
    const { platform, runtime } = platformFor();
    useProjectStore.getState().setProject({ hasContent: true, dirty: true, scope: 'project', systemPresets: { printer: 'System printer', print: 'System process' } });
    const result = await newProject(platform, { decideDirty: () => 'save' });
    expect(result.status).toBe('ok'); expect(runtime.clearModel).toHaveBeenCalled();
    expect(useProjectStore.getState()).toMatchObject({ projectName: 'Untitled', dirty: false, scope: 'system', hasContent: false });
    expect(runtime.selectProfile).toHaveBeenCalledWith('printer', 'System printer');
  });

  it('New preserves the current legal rack for the same system printer and creates one clean baseline', async () => {
    const { platform, runtime } = platformFor();
    const currentRack = filamentSnapshot(7);
    runtime.getFilamentSessionSnapshot.mockResolvedValue(currentRack);
    useFilamentSessionStore.setState({ snapshot: currentRack, rejected: null });
    useProjectStore.getState().setProject({ scope: 'system', systemPresets: { printer: 'System printer', print: 'System process' }, dirty: true, hasContent: true });

    const result = await newProject(platform, { decideDirty: () => 'dont-save' });

    expect(result.status).toBe('ok');
    expect(runtime.applyRememberedFilamentRack).not.toHaveBeenCalled();
    expect(runtime.resetHistory).toHaveBeenCalledOnce();
    expect(runtime.resetHistory.mock.invocationCallOrder[0])
      .toBeLessThan(runtime.getFilamentSessionSnapshot.mock.invocationCallOrder[0]);
    expect(useFilamentSessionStore.getState().snapshot).toBe(currentRack);
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, dirtyReasons: [], scope: 'system', hasContent: false });
  });

  it('New applies the target system printer rack before the clean baseline when leaving another project printer', async () => {
    const { platform, runtime, preferences } = platformFor();
    const systemSnapshot = { ...snapshot,
      printer: { name: 'System printer', idx: 1 }, print: { name: 'System process', idx: 1 } };
    runtime.selectProfile.mockResolvedValue(systemSnapshot);
    const beforeRack = filamentSnapshot(5);
    const targetRack = { ...filamentSnapshot(6), slots: [{ ...filamentSnapshot(6).slots[0], preset: { id: 'system-pla', name: 'System PLA' } }] };
    runtime.getFilamentSessionSnapshot.mockResolvedValueOnce(beforeRack).mockResolvedValue(targetRack);
    runtime.applyRememberedFilamentRack.mockResolvedValue(targetRack);
    preferences.load.mockResolvedValue({ version: 1, selectedProfiles: {}, ui: {},
      rememberedFilamentRacks: { 'System printer': { version: 1, slots: [{ preset: 'System PLA', colour: '#112233' }] } } } as UserPreferences);
    useSettingsStore.setState({ selectedPrinter: 'Project printer', selectedPrint: 'Project process' });
    useProjectStore.getState().setProject({ scope: 'project', systemPresets: { printer: 'System printer', print: 'System process' }, hasContent: true, dirty: true });

    const result = await newProject(platform, { decideDirty: () => 'dont-save' });

    expect(result.status).toBe('ok');
    expect(runtime.applyRememberedFilamentRack).toHaveBeenCalledWith({ version: 1, revision: 5,
      slots: [{ preset: 'System PLA', colour: '#112233' }] });
    expect(runtime.applyRememberedFilamentRack.mock.invocationCallOrder[0])
      .toBeLessThan(runtime.resetHistory.mock.invocationCallOrder[0]);
    expect(runtime.resetHistory.mock.invocationCallOrder[0])
      .toBeLessThan(runtime.getFilamentSessionSnapshot.mock.invocationCallOrder.at(-1)!);
    expect(useFilamentSessionStore.getState().snapshot).toBe(targetRack);
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, dirtyReasons: [], scope: 'system', hasContent: false });
  });

  it('New clears the renderer projection and resets a multi-plate session after runtime success', async () => {
    const { platform, runtime } = platformFor();
    runtime.clearModel.mockResolvedValue({ ok: true, plateSession: freshPlateSession } as never);
    const dispose = vi.fn();
    glVolumeCollection.volumes = [{ dispose } as never];
    const resetForModel = vi.fn();
    useSettingsStore.setState({ modelLoaded: true, values: { modelPath: 'old.stl', layer_height: '0.2' } });
    useSlicerStore.setState({
      status: 'done', resultExported: true, sliceTarget: { plateId: 'old-plate-2', inputRevision: 4 },
      plateResults: { 'old-plate-2': { target: { plateId: 'old-plate-2', inputRevision: 4 }, result: {} as never, warnings: [] } },
    });
    usePlateSessionStore.getState().setSnapshot({
      ...freshPlateSession,
      currentPlateId: 'old-plate-2',
      plates: [
        { plateId: 'old-plate-1', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1' },
        { plateId: 'old-plate-2', displayIndex: 1, origin: [300, 0, 0], name: 'Plate 2' },
      ],
    });

    const result = await newProject(platform, { sceneResetTarget: { resetForModel } });

    expect(result.status).toBe('ok');
    expect(dispose).toHaveBeenCalledOnce();
    expect(resetForModel).toHaveBeenCalledOnce();
    expect(useSettingsStore.getState()).toMatchObject({ modelLoaded: false, values: {} });
    expect(useSlicerStore.getState()).toMatchObject({ status: 'idle', resultExported: false, sliceTarget: null, plateResults: {} });
    expect(usePlateSessionStore.getState().snapshot).toMatchObject({ currentPlateId: 'new-plate-1', plates: [{ plateId: 'new-plate-1' }] });
  });

  it('does not clear the renderer projection when runtime New fails', async () => {
    const { platform, runtime } = platformFor();
    runtime.clearModel.mockResolvedValue({ ok: false, error: 'clear failed' } as never);
    const dispose = vi.fn();
    glVolumeCollection.volumes = [{ dispose } as never];
    const resetForModel = vi.fn();
    const oldSession = {
      ...freshPlateSession,
      currentPlateId: 'old-plate-1',
      plates: [freshPlateSession.plates[0]],
    };
    usePlateSessionStore.getState().setSnapshot(oldSession);
    useSettingsStore.setState({ modelLoaded: true, values: { modelPath: 'old.stl' } });
    useSlicerStore.setState({ status: 'done', resultExported: true });

    const result = await newProject(platform, { sceneResetTarget: { resetForModel } });

    expect(result.status).toBe('failed');
    expect(dispose).not.toHaveBeenCalled();
    expect(resetForModel).not.toHaveBeenCalled();
    expect(useSettingsStore.getState()).toMatchObject({ modelLoaded: true, values: { modelPath: 'old.stl' } });
    expect(useSlicerStore.getState()).toMatchObject({ status: 'done', resultExported: true });
    expect(usePlateSessionStore.getState().snapshot).toBe(oldSession);
  });

  it('does not clear the renderer projection when the dirty gate is cancelled', async () => {
    const { platform, runtime } = platformFor();
    const dispose = vi.fn();
    glVolumeCollection.volumes = [{ dispose } as never];
    const resetForModel = vi.fn();
    useProjectStore.getState().setProject({ dirty: true, hasContent: true });
    useSettingsStore.setState({ modelLoaded: true });

    const result = await newProject(platform, { decideDirty: () => 'cancel', sceneResetTarget: { resetForModel } });

    expect(result.status).toBe('cancelled');
    expect(runtime.clearModel).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(resetForModel).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().modelLoaded).toBe(true);
  });

  it('uses Worker history dirty status as the lifecycle gate authority', async () => {
    const { platform, runtime } = platformFor();
    const status = {
      canUndo: false, canRedo: false, undoEntries: [], redoEntries: [], cursor: 0,
      savedCheckpoint: 0, savedCheckpointEvicted: false, dirty: false, bytesUsed: 0,
      byteBudget: 256 * 1024 * 1024, disabled: false, activeTransactionId: null, revision: 1,
    } as const;
    const getHistoryStatus = vi.fn(async () => status);
    (runtime as unknown as { getHistoryStatus: typeof getHistoryStatus }).getHistoryStatus = getHistoryStatus;
    const decideDirty = vi.fn(() => 'cancel' as const);
    useProjectStore.getState().setProject({ dirty: true, hasContent: true });
    const result = await newProject(platform, { decideDirty });
    expect(result.status).toBe('ok');
    expect(getHistoryStatus).toHaveBeenCalledOnce();
    expect(decideDirty).not.toHaveBeenCalled();
    expect(useProjectStore.getState().dirty).toBe(false);
  });

  it('sorts a batch, asks only for the first 3MF, then appends every remainder', async () => {
    const { platform, runtime } = platformFor();
    const files = [
      { displayName: 'z-model.stl', bytes: new Uint8Array([3]) },
      { displayName: 'b-project.3mf', bytes: new Uint8Array([2]) },
      { displayName: 'a-project.3mf', bytes: new Uint8Array([1]), location: {} as ProjectInput['location'] },
    ];
    const choose = vi.fn(() => 'project' as const);
    const result = await openProjectInputs(platform, files, { loadBehaviour: 'always_ask', chooseLoad: choose });
    expect(result.status).toBe('ok');
    expect(choose).toHaveBeenCalledWith(files[2]);
    expect(runtime.loadProject).toHaveBeenCalledWith(files[2].bytes, 'project', 'a-project.3mf', expect.any(Function));
    expect(runtime.importProjectGeometry).toHaveBeenCalledTimes(2);
    expect(runtime.importProjectGeometry.mock.calls.map((call) => (call as unknown[])[1])).toEqual(['b-project.3mf', 'z-model.stl']);
    expect(useProjectStore.getState()).toMatchObject({ projectName: 'a-project', dirty: true, location: files[2].location });
    expect(sortProjectInputs(files).map((file) => file.displayName)).toEqual(['a-project.3mf', 'b-project.3mf', 'z-model.stl']);
  });

  it('cancelling the first project choice leaves a whole batch untouched', async () => {
    const { platform, runtime } = platformFor();
    const result = await openProjectInputs(platform, [
      { displayName: 'first.3mf', bytes: new Uint8Array([1]) },
      { displayName: 'later.stl', bytes: new Uint8Array([2]) },
    ], { loadBehaviour: 'always_ask', chooseLoad: () => 'cancel' });
    expect(result.status).toBe('cancelled');
    expect(runtime.loadProject).not.toHaveBeenCalled();
    expect(runtime.importProjectGeometry).not.toHaveBeenCalled();
  });

  it('rejects unsupported mixed input before any runtime mutation', async () => {
    const { platform, runtime } = platformFor();
    const result = await openProjectInputs(platform, [
      { displayName: 'project.3mf', bytes: new Uint8Array([1]) },
      { displayName: 'result.gcode', bytes: new Uint8Array([2]) },
    ], { loadBehaviour: 'load_all' });
    expect(result.status).toBe('failed');
    expect(runtime.loadProject).not.toHaveBeenCalled();
    expect(runtime.importProjectGeometry).not.toHaveBeenCalled();
  });

  it('rejects gcode.3mf and bgcode.3mf names before any batch mutation', async () => {
    const { platform, runtime } = platformFor();
    const result = await openProjectInputs(platform, [
      { displayName: 'a-project.3mf', bytes: new Uint8Array([1]) },
      { displayName: 'b.gcode.3mf', bytes: new Uint8Array([2]) },
      { displayName: 'c.bgcode.3mf', bytes: new Uint8Array([3]) },
    ], { loadBehaviour: 'load_all' });
    expect(result.status).toBe('failed');
    expect(runtime.loadProject).not.toHaveBeenCalled();
    expect(runtime.importProjectGeometry).not.toHaveBeenCalled();
  });

  it('keeps native multi-plate projects intact while appending geometry', async () => {
    const { platform, runtime } = platformFor({ multiPlate: true, plateCount: 2 });
    const first = { displayName: 'project.3mf', bytes: new Uint8Array([1]), location: {} as ProjectInput['location'] };
    const result = await openProjectInputs(platform, [first, { displayName: 'part.stl', bytes: new Uint8Array([2]) }], { loadBehaviour: 'load_all' });
    expect(result.status).toBe('ok');
    expect(useProjectStore.getState().flattenedMultiPlate).toBe(false);
    expect(useProjectStore.getState().notices.some((notice) => notice.kind === 'multi-plate')).toBe(false);
  });
});
