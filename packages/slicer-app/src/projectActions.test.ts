import { captureProjectThumbnails } from './components/workspace/projectThumbnails';
vi.mock('@/components/workspace/projectThumbnails', () => ({ captureProjectThumbnails: vi.fn(async () => ({ expectedRevision: 1, thumbnails: [] })) }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_RECENT_PROJECTS } from '@orca/platform-contract';
import type { PlatformCapabilities, ProjectInput, UserPreferences } from '@orca/platform-contract';
import type { FilamentSessionSnapshot, PlateSessionMutation, ProfileSnapshot, ProjectLoadResult } from '@slicer/client';
import { useProjectStore, projectFilenameBase } from './stores/useProjectStore';
import { useSettingsStore } from './stores/useSettingsStore';
import { useSlicerStore } from './stores/useSlicerStore';
import { usePlateSessionStore } from './stores/usePlateSessionStore';
import { useFilamentSessionStore } from './stores/useFilamentSessionStore';
import { useHistoryNavigationStore } from './stores/useHistoryNavigationStore';
import { glVolumeCollection } from './components/workspace/viewport/GLVolume';
import { noticesFor, importProjectGeometry, newProject, openProject, openProjectInputs, saveProject, saveProjectAs, sortProjectInputs } from './projectActions';

const input: ProjectInput = { displayName: 'Robot.3mf', bytes: new Uint8Array([80, 75, 3, 4]) };
const snapshot: ProfileSnapshot = {
  ok: true,
  modifiedPresets: { printer: [], filament: [] },
  printerPicker: { basePrinter: 'Fixture printer', flows: [], items: [{ id: 'project', label: 'Project printer', preset: 'Project printer' }], selectedId: 'project', variants: [], nozzleDiameters: [0.4], selectedVariant: '' },
  printers: [{ name: 'System printer', label: 'System printer', vendor: '', is_visible: true, is_project_embedded: false, is_user: false, is_default: false, vendor_id: '', model: '', variant: '', selected: false }, { name: 'Project printer', label: 'Project printer', vendor: '', is_visible: true, is_project_embedded: false, is_user: false, is_default: false, vendor_id: '', model: '', variant: '', selected: true }],
  prints: [{ name: 'System process', label: 'System process', vendor: '', is_visible: true, is_project_embedded: false, is_user: false, is_default: false, vendor_id: '', model: '', variant: '', selected: false }, { name: 'Project process', label: 'Project process', vendor: '', is_visible: true, is_project_embedded: false, is_user: false, is_default: false, vendor_id: '', model: '', variant: '', selected: true }],
  filamentCatalog: [{ name: 'Project filament', label: 'Project filament', vendor: '', is_visible: true, is_project_embedded: false, is_user: false, is_default: false, vendor_id: '', model: '', variant: '' }],
  printer: { name: 'Project printer', idx: 0 }, print: { name: 'Project process', idx: 0 },
  bedType: { supportsSelection: true, defaultValue: 'Textured PEI Plate', choices: [{ value: 'Textured PEI Plate', label: 'Textured PEI Plate' }] },
};
const freshPlateSession: PlateSessionMutation = {
  instances: [],
  ok: true,
  version: 1,
  currentPlateId: 'new-plate-1',
  plates: [{ plateId: 'new-plate-1', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1' }],
  instanceTransforms: [],
};
const scopedConfigTransport = {
  version: 1 as const,
  revision: 1,
  kind: 'full' as const,
  snapshot: { project: {}, objects: {}, parts: {}, plates: {} },
  removedTargets: [],
};
const loadedHistoryStatus = {
  canUndo: false, canRedo: false, undoEntries: [], redoEntries: [], cursor: 0,
  savedCheckpoint: 0, savedCheckpointEvicted: false, dirty: false, bytesUsed: 0,
  byteBudget: 256 * 1024 * 1024, evictedEntryCount: 0, lastEvictedEntryId: null,
  oldestRetainedEntryId: 'entry-0', oversizedEntryRetained: false, disabled: false,
  activeTransactionId: null, revision: 1,
  editingSession: null, navigationFloor: null,
};
function filamentSnapshot(revision: number): FilamentSessionSnapshot {
  return {
    ok: true, version: 1,
    slots: [{ logicalId: 'filament-1', slot: 1, preset: { isProjectEmbedded: false, isUser: false, id: 'pla', name: `PLA ${revision}`, label: `PLA ${revision}`, vendor: '' }, colour: { effective: '#112233', provenance: 'preset', native: { representative: '#112233', multiColour: '#112233', type: '1' }, display: { mode: 'solid' as const, colors: ['#112233'] } } }],
    mappings: { filament: [1], volume: [0], nozzle: [1], filament2: [1], physicalExtruder: [0] },
    flushing: { matrix: [0], vector: [0], matrixDimension: 1, planeCount: 1, source: 'native' },
    capabilities: { minSlots: 1, maxSlots: 8, nozzleCount: 1, flexible: true, canAdd: true, canDelete: true, canMerge: true },
    assignments: { objects: [], parts: [], modifiers: [] },
    revisions: { session: revision, project: revision, result: 0, plates: {} },
    status: { state: 'ready', error: null },
  };
}
function platformFor(load: Partial<ProjectLoadResult> = {}) {
  let nativeHistory = { ...loadedHistoryStatus };
  const runtime = {
    loadProject: vi.fn(async (_bytes: Uint8Array, _mode?: string, _displayName?: string, _onProgress?: unknown,
      onProjectClosed?: (plateSession: PlateSessionMutation) => void) => {
      onProjectClosed?.(freshPlateSession);
      return { bedTypeNormalization: null, ok: true, objects: 1, instances: 1, mode: 'project' as const, compatibility: 'bambu' as const,
        projectSettingsAvailable: true, presetSnapshot: snapshot, plateSession: freshPlateSession,
        nativeScopedConfig: scopedConfigTransport, historyStatus: loadedHistoryStatus, ...load,
        ...(load.nativeScopedConfig === undefined ? { nativeScopedConfig: scopedConfigTransport } : {}),
        ...(load.historyStatus === undefined ? { historyStatus: loadedHistoryStatus } : {}) };
    }),
    configureProjectFlowMemory: vi.fn(async () => ({ ok: true })),
    closeProject: vi.fn(async () => ({ ok: true, plateSession: freshPlateSession })),
    importProjectGeometry: vi.fn(async () => ({ bedTypeNormalization: null, ok: true, objects: 2, instances: 2, mode: 'geometry-only' as const, compatibility: 'generic' as const, projectSettingsAvailable: false })),
    clearModel: vi.fn(async () => ({ ok: true })),
    exportProject: vi.fn(async () => ({ ok: true, path: '/tmp/project.3mf', bytes: new Uint8Array([1, 2]) })),
    getNativeScopedConfig: vi.fn(async () => ({ ok: true as const, version: 1 as const, nativeScopedConfig: scopedConfigTransport })),
    mutateNativeScopedConfig: vi.fn(async (_request: unknown) => ({ ok: true, nativeScopedConfig: scopedConfigTransport })),
    getProfileSnapshot: vi.fn(async () => snapshot),
    selectProfile: vi.fn(async () => snapshot),
    getFilamentSessionSnapshot: vi.fn(async () => filamentSnapshot(0)),
    applyRememberedFilamentRack: vi.fn(async () => filamentSnapshot(1)),
    getHistoryStatus: vi.fn(async () => nativeHistory),
    markHistorySaved: vi.fn(async () => (nativeHistory = { ...nativeHistory, dirty: false })),
    resetHistory: vi.fn(async () => (nativeHistory = { ...loadedHistoryStatus, revision: nativeHistory.revision + 1 })),
    cancel: vi.fn(async () => ({ ok: true })),
    runProjectHistoryTransaction: vi.fn(async <T>(
      _label: string,
      _category: 'project',
      _before: unknown,
      mutation: (transactionId: string) => Promise<T>,
      _after: unknown | (() => unknown | Promise<unknown>),
    ) => {
      const result = await mutation('tx-1');
      nativeHistory = { ...nativeHistory, dirty: true, revision: nativeHistory.revision + 1 };
      return { sceneDelta: null, result, status: nativeHistory };
    }),
  };
  const projects = {
    open: vi.fn(async () => ({ status: 'ok' as const, input })),
    save: vi.fn(async () => ({ status: 'ok' as const, displayName: 'Robot.3mf', location: undefined as ProjectInput['location'] })),
    saveAs: vi.fn(async () => ({ status: 'ok' as const, displayName: 'Robot.3mf', location: undefined as ProjectInput['location'] })),
  };
  const preferences = { load: vi.fn(async () => ({ version: 1 as const, rememberedBedTypes: {}, selectedProfiles: {}, ui: { switchToDeviceAfterSend: true } })), save: vi.fn(async () => {}) };
  return { runtime, projects, preferences, platform: { runtime, projects, preferences, recentProjects: { ...NO_RECENT_PROJECTS, record: vi.fn(async () => {}) } } as unknown as PlatformCapabilities };
}

describe('transactional project actions', () => {
  it('records only committed project opens and saves using the opaque location', async () => {
    const { platform, projects } = platformFor();
    const location = {} as NonNullable<ProjectInput['location']>;
    projects.open.mockResolvedValue({ status: 'ok', input: { ...input, location } });
    expect((await openProject(platform)).status).toBe('ok');
    expect(platform.recentProjects.record).toHaveBeenCalledWith(location);
    vi.mocked(platform.recentProjects.record).mockClear();
    projects.save.mockResolvedValue({ status: 'ok', displayName: 'Robot.3mf', location });
    useProjectStore.getState().setProject({ hasContent: true });
    expect((await saveProject(platform)).status).toBe('ok');
    expect(platform.recentProjects.record).toHaveBeenCalledWith(location);
  });
  it('records a successful Open geometry-only choice without changing project identity', async () => {
    const { platform, projects } = platformFor();
    const location = {} as NonNullable<ProjectInput['location']>;
    projects.open.mockResolvedValue({ status: 'ok', input: { ...input, location } });
    const result = await openProject(platform, { loadBehaviour: 'load_geometry_only' });
    expect(result.status).toBe('ok');
    expect(platform.recentProjects.record).toHaveBeenCalledWith(location);
    expect(useProjectStore.getState().location).not.toBe(location);
  });
  it('publishes a repaired project open as dirty without saving, seeding memory or adding an entry', async () => {
    const dirtyHistory = { ...loadedHistoryStatus, dirty: true, savedCheckpoint: null };
    const { platform, runtime, projects } = platformFor({ historyStatus: dirtyHistory });
    projects.open.mockResolvedValue({ status: 'ok', input });
    expect((await openProject(platform)).status).toBe('ok');
    expect(useProjectStore.getState().dirty).toBe(true);
    expect(runtime.markHistorySaved).not.toHaveBeenCalled();
    expect(runtime.configureProjectFlowMemory).not.toHaveBeenCalled();
    expect(projects.save).not.toHaveBeenCalled();
    expect(dirtyHistory.undoEntries).toEqual([]);
  });
  it('does not add rejected project loads to history', async () => {
    const { platform, projects } = platformFor({ ok: false });
    projects.open.mockResolvedValue({ status: 'ok', input: { ...input, location: {} as never } });
    expect((await openProject(platform)).status).toBe('failed');
    expect(platform.recentProjects.record).not.toHaveBeenCalled();
  });
  it('keeps a committed open successful if recent history cannot be persisted', async () => {
    const { platform, projects } = platformFor();
    projects.open.mockResolvedValue({ status: 'ok', input: { ...input, location: {} as never } });
    vi.mocked(platform.recentProjects.record).mockRejectedValue(new Error('disk full'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await openProject(platform)).status).toBe('ok');
      expect(logged).toHaveBeenCalledWith('Recent project history could not be saved', expect.any(Error));
    } finally { logged.mockRestore(); }
  });
  it('removes inherited tower rotation override before the New Project clean baseline', async () => {
    const { platform, runtime } = platformFor();
    let project = { wipe_tower_rotation_angle: '90', prime_tower_width: '63', wall_loops: '7' } as Record<string, string>;
    const defaults = { wipe_tower_rotation_angle: '0', prime_tower_width: '35', wall_loops: '2' };
    runtime.getProfileSnapshot.mockImplementation(async () => ({ ...snapshot, project_config: { ...defaults, ...project } }));
    runtime.selectProfile.mockImplementation(async () => ({ ...snapshot, project_config: { ...defaults, ...project } }));
    runtime.mutateNativeScopedConfig.mockImplementation(async (request: unknown) => {
      if ((request as { operation: string }).operation === 'reset-all') project = {};
      return { ok: true, nativeScopedConfig: scopedConfigTransport };
    });
    runtime.getNativeScopedConfig.mockImplementation(async () => ({ ok: true, version: 1,
      nativeScopedConfig: { ...scopedConfigTransport, snapshot: { ...scopedConfigTransport.snapshot, project } } }));
    useSettingsStore.getState().applyNativeScopedConfigTransport({ ...scopedConfigTransport,
      snapshot: { ...scopedConfigTransport.snapshot, project } });
    expect((await newProject(platform)).status).toBe('ok');
    expect(runtime.closeProject).toHaveBeenCalledTimes(1);
    expect(runtime.clearModel).not.toHaveBeenCalled();
    expect(runtime.closeProject.mock.invocationCallOrder[0]).toBeLessThan(runtime.selectProfile.mock.invocationCallOrder[0]);
    expect(useSettingsStore.getState().nativeScopedConfig.project.wipe_tower_rotation_angle).toBeUndefined();
    expect(useSettingsStore.getState().values).toMatchObject(defaults);
    expect(runtime.mutateNativeScopedConfig).toHaveBeenCalledWith({ version: 1, operation: 'reset-all',
      targets: [{ scope: 'project' }] });
    expect(runtime.mutateNativeScopedConfig.mock.invocationCallOrder[0]).toBeLessThan(runtime.resetHistory.mock.invocationCallOrder[0]);
  });

  it('publishes the loaded clean baseline instead of retaining old Undo and Redo', async () => {
    const { platform, runtime } = platformFor();
    useHistoryNavigationStore.getState().setStatus({
      ...loadedHistoryStatus, revision: 20, canUndo: true, canRedo: true,
      undoEntries: [{ id: 'old-undo', label: 'Move', category: 'project' }],
      redoEntries: [{ id: 'old-redo', label: 'Delete', category: 'project' }],
    });
    expect((await openProject(platform, { loadBehaviour: 'load_all' })).status).toBe('ok');
    expect(useHistoryNavigationStore.getState().status).toEqual(loadedHistoryStatus);
    expect(runtime.resetHistory).not.toHaveBeenCalled();
  });

  it('clears projected history at the close boundary even if loading then fails', async () => {
    const { platform, runtime } = platformFor();
    useHistoryNavigationStore.getState().setStatus({
      ...loadedHistoryStatus, canUndo: true,
      undoEntries: [{ id: 'old-undo', label: 'Move', category: 'project' }],
    });
    runtime.loadProject.mockImplementation(async (_bytes, _mode, _name, _progress, closed) => {
      closed?.(freshPlateSession);
      expect(useHistoryNavigationStore.getState().status).toBeNull();
      throw new Error('invalid 3MF');
    });
    expect((await openProject(platform, { loadBehaviour: 'load_all' })).status).toBe('failed');
    expect(useHistoryNavigationStore.getState().status).toBeNull();
  });

  it('retains projected history when Open is cancelled before project close', async () => {
    const { platform, runtime } = platformFor();
    const previous = { ...loadedHistoryStatus, canUndo: true,
      undoEntries: [{ id: 'old-undo', label: 'Move', category: 'project' as const }] };
    useHistoryNavigationStore.getState().setStatus(previous);
    useSettingsStore.setState({ modelLoaded: true });
    expect((await openProject(platform, { loadBehaviour: 'always_ask', chooseLoad: () => 'cancel' })).status).toBe('cancelled');
    expect(useHistoryNavigationStore.getState().status).toBe(previous);
    expect(runtime.loadProject).not.toHaveBeenCalled();
    useHistoryNavigationStore.getState().reset();
  });

  it('publishes final native bed root when New Project seed is already unchanged', async () => {
    const { platform, runtime } = platformFor();
    runtime.getNativeScopedConfig.mockResolvedValue({ ok: true, version: 1, nativeScopedConfig: { ...scopedConfigTransport, snapshot: { ...scopedConfigTransport.snapshot, project: { curr_bed_type: 'Textured PEI Plate' } } } });
    expect((await newProject(platform)).status).toBe('ok');
    expect(useSettingsStore.getState().values.curr_bed_type).toBe('Textured PEI Plate');
    expect(runtime.getNativeScopedConfig.mock.invocationCallOrder.at(-1)).toBeLessThan(runtime.resetHistory.mock.invocationCallOrder[0]);
  });

  it('seeds New Project bed memory before baseline, but never applies it to an opened project', async () => {
    const { platform, runtime, preferences } = platformFor();
    preferences.load.mockResolvedValue({ version: 1, selectedProfiles: {}, ui: { switchToDeviceAfterSend: true },
      rememberedBedTypes: { 'Project printer': 'Textured PEI Plate' } } as UserPreferences);
    runtime.mutateNativeScopedConfig.mockResolvedValue({ ok: true, version: 1, nativeScopedConfig: { version: 1, kind: 'delta', revision: 2, baseRevision: 1, set: [], removedTargets: [] } } as never);
    runtime.getNativeScopedConfig.mockResolvedValue({ ok: true, version: 1, nativeScopedConfig: { ...scopedConfigTransport, revision: 2, snapshot: { ...scopedConfigTransport.snapshot, project: { curr_bed_type: 'Textured PEI Plate' } } } });
    useSettingsStore.setState({ selectedPrinter: 'Project printer', selectedPrint: 'Project process' });
    useProjectStore.getState().setProject({ systemPresets: { printer: 'Project printer', print: 'Project process' } });
    expect((await newProject(platform)).status).toBe('ok');
    expect(runtime.mutateNativeScopedConfig).toHaveBeenCalledTimes(2);
    expect(useSettingsStore.getState().nativeScopedConfig.project.curr_bed_type).toBe('Textured PEI Plate');
    expect(runtime.mutateNativeScopedConfig.mock.invocationCallOrder[0]).toBeLessThan(runtime.resetHistory.mock.invocationCallOrder[0]);
    runtime.mutateNativeScopedConfig.mockClear();
    expect((await openProject(platform)).status).toBe('ok');
    expect(runtime.mutateNativeScopedConfig).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    useProjectStore.getState().reset();
    useHistoryNavigationStore.getState().reset();
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
    useProjectStore.setState({ dirty: true, hasContent: true });
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
    expect(runtime.applyRememberedFilamentRack).not.toHaveBeenCalled();
    expect(useFilamentSessionStore.getState().snapshot).toMatchObject({
      slots: [{ preset: { name: 'PLA 0' } }],
    });
    expect(useProjectStore.getState()).toMatchObject({ projectName: 'Robot', scope: 'project', dirty: false });
  });

  it('returns an identity-preserving receipt only after the native project commit succeeds', async () => {
    const { platform, runtime } = platformFor({ displayName: 'Native Robot.3mf', multiPlate: true, plateCount: 4 });
    const result = await openProject(platform, { loadBehaviour: 'load_all' });

    expect(result).toMatchObject({
      status: 'ok',
      loadReceipt: {
        sourceDisplayName: 'Robot.3mf',
        sourceByteLength: input.bytes.byteLength,
        commitRoute: 'load-project',
        nativeResult: { ok: true, displayName: 'Native Robot.3mf', multiPlate: true, plateCount: 4 },
      },
    });
    expect(runtime.resetHistory).not.toHaveBeenCalled();
  });

  it('commits an embedded Process preset without opening a confirmation dialog', async () => {
    const result: ProjectLoadResult = { bedTypeNormalization: null, ok: true, objects: 1, instances: 1, mode: 'project', compatibility: 'bambu', projectSettingsAvailable: true, presetSnapshot: snapshot,
      embeddedPresetWarnings: { present: true, count: 1, printerCount: 0, processCount: 1, filamentCount: 0, modifiedPrinterGcode: false, modifiedFilamentGcode: false, missingSystemPreset: false, requiresConfirmation: false, filamentSlotChanges: [] } };
    const { platform, runtime } = platformFor(result);
    const confirm = vi.fn(() => true);
    const opened = await openProject(platform, { loadBehaviour: 'load_all', confirmProjectLoad: confirm });
    expect(opened.status).toBe('ok');
    expect(opened.loadReceipt?.commitRoute).toBe('load-project');
    expect(confirm).not.toHaveBeenCalled();
    expect(runtime.loadProject).toHaveBeenCalledTimes(1);
    expect(runtime.closeProject).not.toHaveBeenCalled();
    expect(useProjectStore.getState().notices).toEqual([]);
  });

  it('reopens installed user Printer and Filament presets without a notice or confirmation', async () => {
    const userSnapshot: ProfileSnapshot = {
      ...snapshot,
      printers: snapshot.printers.map(preset => preset.selected ? { ...preset, is_user: true } : preset),
      filamentCatalog: snapshot.filamentCatalog.map(preset => ({ ...preset, is_user: true })),
    };
    const { platform, runtime } = platformFor({
      presetSnapshot: userSnapshot,
      embeddedPresetWarnings: { present: true, count: 2, printerCount: 1, processCount: 0, filamentCount: 1,
        modifiedPrinterGcode: false, modifiedFilamentGcode: false, missingSystemPreset: false,
        requiresConfirmation: false, filamentSlotChanges: [] },
    });
    const confirm = vi.fn(() => true);
    const opened = await openProject(platform, { loadBehaviour: 'load_all', confirmProjectLoad: confirm });
    expect(opened.status).toBe('ok');
    expect(confirm).not.toHaveBeenCalled();
    expect(runtime.closeProject).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().selectedPrinter).toBe(userSnapshot.printer.name);
    expect(useProjectStore.getState().notices).toEqual([]);
  });

  it('shows post-close warning confirmation and leaves the fresh empty session on rejection', async () => {
    useProjectStore.setState({ projectName: 'Prior', hasContent: true, dirty: true });
    const result: ProjectLoadResult = { bedTypeNormalization: null, ok: true, objects: 1, instances: 1, mode: 'project', compatibility: 'bambu', projectSettingsAvailable: true, presetSnapshot: snapshot,
      embeddedPresetWarnings: { present: true, count: 1, printerCount: 1, processCount: 0, filamentCount: 0, modifiedPrinterGcode: false, modifiedFilamentGcode: false, missingSystemPreset: false, requiresConfirmation: true, filamentSlotChanges: [{ slot: 1, before: 'A', after: 'B', reason: 'native-compatibility' }] } };
    const { platform, runtime } = platformFor(result);
    const cancelled = await openProject(platform, { loadBehaviour: 'load_all', decideDirty: () => 'dont-save', confirmProjectLoad: () => false });
    expect(cancelled.status).toBe('cancelled');
    expect(runtime.closeProject).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState()).toMatchObject({ projectName: 'Untitled', hasContent: false, dirty: false });
    expect(usePlateSessionStore.getState().snapshot?.currentPlateId).toBe('new-plate-1');
  });

  it('closes the loaded candidate when warning confirmation throws and keeps failure post-close', async () => {
    const warning: ProjectLoadResult = { bedTypeNormalization: null, ok: true, objects: 1, instances: 1, mode: 'project', compatibility: 'bambu', projectSettingsAvailable: true, presetSnapshot: snapshot,
      embeddedPresetWarnings: { present: true, count: 1, printerCount: 1, processCount: 0, filamentCount: 0, modifiedPrinterGcode: false, modifiedFilamentGcode: false, missingSystemPreset: false, requiresConfirmation: true } };
    const thrown = platformFor(warning);
    const confirmationError = new Error('dialog closed');
    expect((await openProject(thrown.platform, { loadBehaviour: 'load_all', confirmProjectLoad: () => { throw confirmationError; } })).status).toBe('failed');
    expect(thrown.runtime.closeProject).toHaveBeenCalledTimes(1);

    useProjectStore.setState({ projectName: 'Prior', hasContent: true, dirty: false });
    const failed = platformFor({ ok: false, error: 'load failed', objects: 0, instances: 0 });
    const failedResultAction = await openProject(failed.platform, { loadBehaviour: 'load_all' });
    expect(failedResultAction.status).toBe('failed');
    expect(useProjectStore.getState()).toMatchObject({ projectName: 'Untitled', hasContent: false, dirty: false });
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
      return { dirty: false } as never;
    });

    const result = await openProject(platform, { loadBehaviour: 'load_all' });

    expect(result.status).toBe('ok');
    expect(runtime.resetHistory).not.toHaveBeenCalled();
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

  it('commits the opening dialog state through a frame before native loading starts', async () => {
    const { platform, runtime } = platformFor();
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    let frameEnded = false;
    const frame = vi.fn((callback: FrameRequestCallback) => {
      queueMicrotask(() => {
        callback(performance.now());
        frameEnded = true;
      });
      return 1;
    });
    globalThis.requestAnimationFrame = frame;
    runtime.loadProject.mockImplementation(async (_bytes, _mode, _displayName, _onProgress, onProjectClosed) => {
      expect(frameEnded).toBe(true);
      expect(useProjectStore.getState().operation).toMatchObject({
        phase: 'loading', progress: 0, message: 'Opening project',
      });
      onProjectClosed?.(freshPlateSession);
      return { bedTypeNormalization: null, ok: true, objects: 1, instances: 1, mode: 'project' as const,
        compatibility: 'bambu' as const, projectSettingsAvailable: true,
        presetSnapshot: snapshot, plateSession: freshPlateSession,
        nativeScopedConfig: scopedConfigTransport, historyStatus: loadedHistoryStatus };
    });

    try {
      const result = await openProject(platform, { loadBehaviour: 'load_all' });
      expect(result.status).toBe('ok');
      expect(frame).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
  });

  it('geometry import never replaces active settings and makes the session dirty', async () => {
    const { platform } = platformFor();
    useSettingsStore.setState({ modelLoaded: true, selectedPrinter: 'Current printer', selectedPrint: 'Current process', values: { layer_height: '0.2' } });
    await importProjectGeometry(platform, input);
    expect(useSettingsStore.getState()).toMatchObject({ selectedPrinter: 'Current printer', selectedPrint: 'Current process', values: { layer_height: '0.2' } });
    expect(useProjectStore.getState()).toMatchObject({ projectName: 'Untitled', dirty: true, hasContent: true });
  });

  it('distinguishes an unsaved Untitled session from an opened Untitled.3mf without a host location', async () => {
    expect(projectFilenameBase(useProjectStore.getState())).toBe('');
    const { platform } = platformFor();
    expect((await openProject(platform, { inputs: [{ ...input, displayName: 'Untitled.3mf' }], loadBehaviour: 'load_all' })).status).toBe('ok');
    expect(useProjectStore.getState()).toMatchObject({ projectName: 'Untitled', projectFileName: 'Untitled.3mf', location: undefined });
    expect(projectFilenameBase(useProjectStore.getState())).toBe('Untitled');
    expect((await newProject(platform)).status).toBe('ok');
    expect(useProjectStore.getState().projectFileName).toBeNull();
    expect(projectFilenameBase(useProjectStore.getState())).toBe('');
  });

  it.each([false, true])('save as copy=%s adopts the actual host filename and overwrite location', async (asCopy) => {
    const { platform, projects } = platformFor();
    const oldLocation = {} as NonNullable<ProjectInput['location']>;
    const newLocation = {} as NonNullable<ProjectInput['location']>;
    useProjectStore.setState({ projectName: 'Old', projectFileName: 'Old.3mf', location: oldLocation, hasContent: true, dirty: true });
    const hostSave = asCopy ? projects.saveAs : projects.save;
    hostSave.mockResolvedValue({ status: 'ok', displayName: 'Chosen.Name.3MF', location: newLocation });
    expect((await (asCopy ? saveProjectAs : saveProject)(platform)).status).toBe('ok');
    expect(hostSave).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'Old.3mf', location: oldLocation }));
    expect(useProjectStore.getState()).toMatchObject({ projectName: 'Chosen.Name', projectFileName: 'Chosen.Name.3MF', location: newLocation, dirty: false });
    expect(projectFilenameBase(useProjectStore.getState())).toBe('Chosen.Name');
  });

  it.each([saveProject, saveProjectAs])('saves a parameter-only dirty project and allows a clean copy', async (save) => {
    const { platform, runtime, projects } = platformFor();
    useProjectStore.setState({ hasContent: false, dirty: true });
    expect((await save(platform)).status).toBe('ok');
    expect(runtime.exportProject).toHaveBeenCalledOnce();
    expect(runtime.markHistorySaved).toHaveBeenCalledOnce();
    expect(useProjectStore.getState()).toMatchObject({ hasContent: true, dirty: false, projectFileName: 'Robot.3mf' });
    expect((await saveProjectAs(platform)).status).toBe('ok');
    expect(projects.saveAs).toHaveBeenCalled();
  });

  it('keeps every stage of project saving non-cancellable', async () => {
    const { platform } = platformFor();
    useProjectStore.setState({ hasContent: true, dirty: true });
    const stages: boolean[] = [];
    const unsubscribe = useProjectStore.subscribe(({ operation }) => {
      if (operation.phase === 'saving') stages.push(operation.cancellable);
    });
    try {
      expect((await saveProject(platform)).status).toBe('ok');
      expect(stages.length).toBeGreaterThan(0);
      expect(stages.every(cancellable => !cancellable)).toBe(true);
    } finally { unsubscribe(); }
  });

  it('keeps dirty state and avoids host writes after thumbnail failure', async () => {
    const { platform, runtime, projects } = platformFor();
    useProjectStore.setState({ hasContent: true, dirty: true });
    vi.mocked(captureProjectThumbnails).mockRejectedValueOnce(new Error('thumbnail failed'));
    expect((await saveProject(platform)).status).toBe('failed');
    expect(runtime.exportProject).not.toHaveBeenCalled();
    expect(projects.save).not.toHaveBeenCalled();
    expect(runtime.markHistorySaved).not.toHaveBeenCalled();
    expect(useProjectStore.getState().dirty).toBe(true);
  });

  it('cancelled saving of a parameter-only project retains its unsaved changes', async () => {
    const { platform, runtime, projects } = platformFor();
    useProjectStore.setState({ hasContent: false, dirty: true });
    projects.save.mockResolvedValue({ status: 'cancelled' } as never);
    expect((await saveProject(platform)).status).toBe('cancelled');
    expect(runtime.markHistorySaved).not.toHaveBeenCalled();
    expect(useProjectStore.getState()).toMatchObject({ hasContent: false, dirty: true, projectFileName: null });
  });

  it('first Web save establishes filename identity without an overwrite location', async () => {
    const { platform, projects } = platformFor();
    useProjectStore.setState({ hasContent: true, dirty: true });
    projects.save.mockResolvedValue({ status: 'ok', displayName: 'Untitled.3mf', location: undefined });
    expect((await saveProject(platform)).status).toBe('ok');
    expect(useProjectStore.getState()).toMatchObject({ projectFileName: 'Untitled.3mf', projectName: 'Untitled', location: undefined });
    expect(projectFilenameBase(useProjectStore.getState())).toBe('Untitled');
  });

  it('geometry-only Open preserves an existing project filename and location', async () => {
    const { platform } = platformFor();
    const location = {} as NonNullable<ProjectInput['location']>;
    useProjectStore.getState().setProject({ projectName: 'Existing', projectFileName: 'Existing.3mf', location });
    expect((await openProject(platform, { loadBehaviour: 'load_geometry_only' })).status).toBe('ok');
    expect(useProjectStore.getState()).toMatchObject({ projectName: 'Existing', projectFileName: 'Existing.3mf', location, dirty: true });
    expect(projectFilenameBase(useProjectStore.getState())).toBe('Existing');
  });

  it('cancelled/failed saves leave the clean baseline and dirty state untouched', async () => {
    const cancelled = platformFor(); cancelled.projects.save.mockResolvedValue({ status: 'cancelled' } as never);
    const location = {} as NonNullable<ProjectInput['location']>;
    useProjectStore.setState({ hasContent: true, dirty: true, projectName: 'Robot', projectFileName: 'Robot.3mf', location });
    expect((await saveProject(cancelled.platform)).status).toBe('cancelled');
    expect(useProjectStore.getState().dirty).toBe(true);
    expect(useProjectStore.getState()).toMatchObject({ projectName: 'Robot', projectFileName: 'Robot.3mf', location });

    const failed = platformFor(); failed.runtime.exportProject.mockResolvedValue({ ok: false, path: '', bytes: new Uint8Array(), error: 'export failed' } as never);
    expect((await saveProject(failed.platform)).status).toBe('failed');
    expect(useProjectStore.getState().dirty).toBe(true);
    expect(useProjectStore.getState()).toMatchObject({ projectName: 'Robot', projectFileName: 'Robot.3mf', location });
  });

  it('Save then New restores the saved global preset selection', async () => {
    const { platform, runtime } = platformFor();
    runtime.getHistoryStatus.mockResolvedValue({ ...loadedHistoryStatus, dirty: true });
    useProjectStore.setState({ hasContent: true, dirty: true, scope: 'project', systemPresets: { printer: 'System printer', print: 'System process' } });
    const result = await newProject(platform, { decideDirty: () => 'save' });
    expect(result.status).toBe('ok'); expect(runtime.closeProject).toHaveBeenCalled();
    expect(useProjectStore.getState()).toMatchObject({ projectName: 'Untitled', dirty: false, scope: 'system', hasContent: false });
    expect(runtime.selectProfile).toHaveBeenCalledWith('printer', 'System printer');
  });

  it.each(['printer', 'print'] as const)('New does not reselect a deleted %s snapshot after native session closure', async (kind) => {
    const { platform, runtime } = platformFor();
    const stale = 'Deleted user preset [snapshot 1]';
    useSettingsStore.setState(kind === 'printer' ? { selectedPrinter: stale } : { selectedPrint: stale });
    useProjectStore.setState({ scope: 'system', dirty: true, hasContent: true,
      systemPresets: { printer: kind === 'printer' ? stale : snapshot.printer!.name,
        print: kind === 'print' ? stale : snapshot.print!.name } });
    runtime.selectProfile.mockImplementation(async (_kind?: unknown, name?: unknown) => {
      if (name === stale) throw new Error('preset not found');
      return snapshot;
    });

    expect((await newProject(platform, { decideDirty: () => 'dont-save' })).status).toBe('ok');
    expect(runtime.selectProfile).not.toHaveBeenCalledWith(kind, stale);
    expect(useProjectStore.getState().systemPresets).toEqual({ printer: snapshot.printer!.name, print: snapshot.print!.name });
    expect(runtime.closeProject.mock.invocationCallOrder[0]).toBeLessThan(runtime.getProfileSnapshot.mock.invocationCallOrder[0]);
    expect(useSettingsStore.getState()).toMatchObject({ selectedPrinter: snapshot.printer!.name, selectedPrint: snapshot.print!.name });
    expect(runtime.resetHistory).toHaveBeenCalledOnce();
  });

  it('New preserves the current legal rack for the same system printer and creates one clean baseline', async () => {
    const { platform, runtime } = platformFor();
    const currentRack = filamentSnapshot(7);
    runtime.getFilamentSessionSnapshot.mockResolvedValue(currentRack);
    useFilamentSessionStore.setState({ snapshot: currentRack, rejected: null });
    useProjectStore.setState({ scope: 'system', systemPresets: { printer: 'System printer', print: 'System process' }, dirty: true, hasContent: true });

    const result = await newProject(platform, { decideDirty: () => 'dont-save' });

    expect(result.status).toBe('ok');
    expect(runtime.applyRememberedFilamentRack).not.toHaveBeenCalled();
    expect(runtime.resetHistory).toHaveBeenCalledOnce();
    expect(runtime.resetHistory.mock.invocationCallOrder[0])
      .toBeLessThan(runtime.getFilamentSessionSnapshot.mock.invocationCallOrder[0]);
    expect(useFilamentSessionStore.getState().snapshot).toBe(currentRack);
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, scope: 'system', hasContent: false });
  });

  it('New applies the target system printer rack before the clean baseline when leaving another project printer', async () => {
    const { platform, runtime, preferences } = platformFor();
    const systemSnapshot = { ...snapshot,
      printer: { name: 'System printer', idx: 1 }, print: { name: 'System process', idx: 1 } };
    runtime.selectProfile.mockResolvedValue(systemSnapshot);
    const beforeRack = filamentSnapshot(5);
    const targetRack = { ...filamentSnapshot(6), slots: [{ ...filamentSnapshot(6).slots[0], preset: { isProjectEmbedded: false, isUser: false, id: 'system-pla', name: 'System PLA', label: 'System PLA', vendor: '' } }] };
    runtime.getFilamentSessionSnapshot.mockResolvedValueOnce(beforeRack).mockResolvedValue(targetRack);
    runtime.applyRememberedFilamentRack.mockResolvedValue(targetRack);
    preferences.load.mockResolvedValue({ version: 1, rememberedBedTypes: {}, selectedProfiles: {}, ui: { switchToDeviceAfterSend: true },
      rememberedFilamentRacks: { 'System printer': { version: 1, slots: [{ preset: 'System PLA', colour: '#112233', native: { representative: '#112233', multiColour: '#112233', type: '1' } }] } } } as UserPreferences);
    useSettingsStore.setState({ selectedPrinter: 'Project printer', selectedPrint: 'Project process' });
    useProjectStore.setState({ scope: 'project', systemPresets: { printer: 'System printer', print: 'System process' }, hasContent: true, dirty: true });

    const result = await newProject(platform, { decideDirty: () => 'dont-save' });

    expect(result.status).toBe('ok');
    expect(runtime.applyRememberedFilamentRack).toHaveBeenCalledWith({ version: 1, revision: 5,
      slots: [{ preset: 'System PLA', colour: '#112233', native: { representative: '#112233', multiColour: '#112233', type: '1' } }] });
    expect(runtime.applyRememberedFilamentRack.mock.invocationCallOrder[0])
      .toBeLessThan(runtime.resetHistory.mock.invocationCallOrder[0]);
    expect(runtime.resetHistory.mock.invocationCallOrder[0])
      .toBeLessThan(runtime.getFilamentSessionSnapshot.mock.invocationCallOrder.at(-1)!);
    expect(useFilamentSessionStore.getState().snapshot).toBe(targetRack);
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, scope: 'system', hasContent: false });
  });

  it('New clears the renderer projection and resets a multi-plate session after runtime success', async () => {
    const { platform, runtime } = platformFor();
    runtime.closeProject.mockResolvedValue({ ok: true, plateSession: freshPlateSession } as never);
    const dispose = vi.fn();
    glVolumeCollection.volumes = [{ dispose } as never];
    const resetForModel = vi.fn();
    useSettingsStore.setState({ modelLoaded: true, values: { modelPath: 'old.stl', layer_height: '0.2' } });
    useSlicerStore.setState({
      status: 'done', resultExported: true, sliceTarget: { plateId: 'old-plate-2', inputRevision: 4 },
      plateResults: { 'old-plate-2': {
        target: { plateId: 'old-plate-2', inputRevision: 4 },
        receipt: { plateId: 'old-plate-2', inputStamp: 4, resultGeneration: '1', sliceTaskId: '1' }, warnings: [], summary: {},
      } },
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
    expect(usePlateSessionStore.getState().snapshot).toMatchObject({ instances: [], currentPlateId: 'new-plate-1', plates: [{ plateId: 'new-plate-1' }] });
  });

  it('does not clear the renderer projection when runtime New fails', async () => {
    const { platform, runtime } = platformFor();
    runtime.closeProject.mockResolvedValue({ ok: false, error: 'clear failed' } as never);
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
    runtime.getHistoryStatus.mockResolvedValue({ ...loadedHistoryStatus, dirty: true });
    const dispose = vi.fn();
    glVolumeCollection.volumes = [{ dispose } as never];
    const resetForModel = vi.fn();
    useProjectStore.setState({ dirty: true, hasContent: true });
    useSettingsStore.setState({ modelLoaded: true });

    const result = await newProject(platform, { decideDirty: () => 'cancel', sceneResetTarget: { resetForModel } });

    expect(result.status).toBe('cancelled');
    expect(runtime.closeProject).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(resetForModel).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().modelLoaded).toBe(true);
  });

  it.each([false, true])('uses Worker dirty=%s as the lifecycle gate authority over a stale UI projection', async dirty => {
    const { platform, runtime } = platformFor();
    runtime.getHistoryStatus.mockResolvedValue({ ...loadedHistoryStatus, dirty });
    const decideDirty = vi.fn(() => 'cancel' as const);
    useProjectStore.setState({ dirty: !dirty, hasContent: true });
    const result = await newProject(platform, { decideDirty });
    expect(result.status).toBe(dirty ? 'cancelled' : 'ok');
    expect(runtime.getHistoryStatus).toHaveBeenCalledOnce();
    expect(decideDirty).toHaveBeenCalledTimes(dirty ? 1 : 0);
    expect(useProjectStore.getState().dirty).toBe(dirty);
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
    expect(runtime.loadProject).toHaveBeenCalledWith(files[2].bytes, 'project', 'a-project.3mf',
      expect.any(Function), expect.any(Function));
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
    expect(useProjectStore.getState().notices.some((notice) => notice.kind === 'multi-plate')).toBe(false);
  });
});

it('reports native imported bed correction', () => {
  const notices = noticesFor({ ok: true, objects: 1, instances: 1, bedTypeNormalization: { globalChanged: true, removedPlateOverrideIds: ['plate-1'] } });
  expect(notices).toEqual([expect.objectContaining({ kind: 'bed-type-normalization', message: expect.stringContaining('1 local override(s)') })]);

});

describe('native project preset notices', () => {
  const cleanWarning: NonNullable<ProjectLoadResult['embeddedPresetWarnings']> = {
    present: true, count: 2, printerCount: 1, processCount: 0, filamentCount: 1,
    modifiedPrinterGcode: false, modifiedFilamentGcode: false, missingSystemPreset: false,
    requiresConfirmation: false, filamentSlotChanges: [],
  };

  it.each(['modifiedPrinterGcode', 'modifiedFilamentGcode', 'missingSystemPreset'] as const)(
    'retains the native safety warning for %s even without embedded archive records', flag => {
      const warning = { ...cleanWarning, present: false, count: 0, [flag]: true, requiresConfirmation: true };
      expect(noticesFor({ ok: true, bedTypeNormalization: null, objects: 0, instances: 0, embeddedPresetWarnings: warning }))
        .toEqual([expect.objectContaining({ kind: 'embedded-presets', details: warning })]);
    },
  );

  it('reports native filament replacements without implying unsafe embedded presets', () => {
    const warning: NonNullable<ProjectLoadResult['embeddedPresetWarnings']> = { ...cleanWarning, filamentSlotChanges: [
      { slot: 1, before: 'Missing PLA', after: 'Generic PLA', reason: 'native-compatibility' },
    ] };
    expect(noticesFor({ ok: true, bedTypeNormalization: null, objects: 0, instances: 0, embeddedPresetWarnings: warning }))
      .toEqual([expect.objectContaining({ kind: 'compatibility-fallback',
        message: 'Some filament slots were changed while loading this project.', details: warning })]);
  });
});
