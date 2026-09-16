import type { PlatformCapabilities, ProjectInput } from '@orca/platform-contract';
import type { PlateSessionMutation, ProjectLoadResult, SlicerClient } from '@slicer/client';
import type { HistoryContext, HistoryStatus } from '@slicer/client';
import { compatibilityFallback, projectNameFromDisplayName, shouldAskProjectLoad, type DirtyProjectDecision, type ProjectLoadChoice } from '@orca/slicer-runtime';
import { useProjectStore, projectPresetSelections, type ProjectNotice, type ProjectPresetSelections } from './stores/useProjectStore';
import { emptyProjectConfigOverlay, useSettingsStore } from './stores/useSettingsStore';
import { useSlicerStore } from './stores/useSlicerStore';
import { applyPlateSessionTransforms } from './components/workspace/actions/syncModelTransforms';
import { glVolumeCollection } from './components/workspace/viewport/GLVolume';
import { usePlateSessionStore } from './stores/usePlateSessionStore';
import type { SceneResetTarget } from './components/workspace/actions/resetSceneState';
import { resetSceneState } from './components/workspace/actions/resetSceneState';
import {
  runProjectHistoryMutation,
  readProjectHistoryStatus,
  markProjectHistorySaved,
  resetProjectHistory,
  recordProjectHistoryContext,
} from './components/workspace/actions/historyMutation';
import { applyRememberedFilamentRackFromRepository } from './preferences';

export interface ProjectActionOptions {
  /** Inputs supplied by a drag/drop surface; picker input is used otherwise. */
  inputs?: readonly ProjectInput[];
  /** Keep the opened project's identity while appending later batch files. */
  preserveSessionIdentity?: boolean;
  loadBehaviour?: 'load_all' | 'ask_when_relevant' | 'always_ask' | 'load_geometry_only';
  chooseLoad?: (input: ProjectInput) => Promise<ProjectLoadChoice> | ProjectLoadChoice;
  /** Explicit acceptance after the closed-session project load reports warnings. */
  confirmProjectLoad?: (load: ProjectLoadResult) => Promise<boolean> | boolean;
  decideDirty?: (operation: 'new' | 'open' | 'close', input?: ProjectInput) => Promise<DirtyProjectDecision> | DirtyProjectDecision;
  /** Legacy compatibility hook; multi-plate projects are now persisted natively. */
  confirmFlattenedSave?: () => Promise<boolean> | boolean;
  signal?: AbortSignal;
  /** Renderer cleanup hook used after a successful New Project runtime reset. */
  sceneResetTarget?: SceneResetTarget | null;
}
export type ProjectLoadCommitRoute = 'load-project';

/**
 * A completed project replacement receipt. It is deliberately limited to the
 * caller's input identity and the native result: host locations remain opaque
 * and are never included here.
 */
export interface ProjectLoadReceipt {
  readonly sourceDisplayName: string;
  readonly sourceByteLength: number;
  readonly commitRoute: ProjectLoadCommitRoute;
  readonly nativeResult: ProjectLoadResult;
}

export interface ProjectActionResult {
  status: 'ok' | 'cancelled' | 'failed';
  error?: unknown;
  load?: ProjectLoadResult;
  loadReceipt?: ProjectLoadReceipt;
}
type Runtime = Pick<SlicerClient, 'loadProject' | 'closeProject' | 'importProjectGeometry' | 'clearModel' | 'exportProject' | 'getProfileSnapshot' | 'selectProfile' | 'cancel' | 'getFilamentSessionSnapshot' | 'getModelStructure' | 'getPlateSessionSnapshot' | 'applyRememberedFilamentRack' | 'runProjectHistoryTransaction'> &
  Pick<SlicerClient, 'getHistoryStatus' | 'markHistorySaved' | 'recordHistoryContext' | 'resetHistory'>;

function errorResult(error: unknown): ProjectActionResult { return { status: 'failed', error }; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function runtimeOf(platform: PlatformCapabilities): Runtime { return platform.runtime; }
function currentPresets(): ProjectPresetSelections {
  const s = useSettingsStore.getState();
  return { printer: s.selectedPrinter, print: s.selectedPrint };
}
export function noticesFor(load: ProjectLoadResult): ProjectNotice[] {
  const notices: ProjectNotice[] = [];
  const fallback = compatibilityFallback(load); if (fallback) notices.push({ kind: 'compatibility-fallback', message: fallback });
  if (load.embeddedPresetWarnings?.present) notices.push({ kind: 'embedded-presets', message: 'This project contains embedded preset settings that may differ from system presets.', details: load.embeddedPresetWarnings });
  return notices;
}
function setOperation(phase: Parameters<ReturnType<typeof useProjectStore.getState>['setOperation']>[0]['phase'], progress = 0, message?: string): void {
  useProjectStore.getState().setOperation({ phase, progress, message, cancellable: phase === 'loading' || phase === 'saving' });
}
function invalidateInput(): void { useSlicerStore.getState().invalidateSliceResult(); }
function projectedHistoryContext(): HistoryContext {
  return {
    selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
    activePlateId: usePlateSessionStore.getState().snapshot?.currentPlateId ?? null,
    gizmo: null,
    projectConfigOverlay: useSettingsStore.getState().overlay as unknown as HistoryContext['projectConfigOverlay'],
  };
}
async function currentHistoryStatus(runtime: Runtime): Promise<HistoryStatus> {
  const status = await readProjectHistoryStatus(runtime, false);
  if (!status) throw new Error('project history status read failed');
  return status;
}
/** Read the Worker checkpoint state for lifecycle guards. */
export async function projectDirtyStatus(platform: PlatformCapabilities): Promise<boolean> {
  const projectedBeforeQuery = useProjectStore.getState();
  const status = await currentHistoryStatus(runtimeOf(platform));
  return status.dirty || projectedBeforeQuery.dirtyReasons.length > 0;
}
async function markHistorySaved(runtime: Runtime): Promise<HistoryStatus> {
  return markProjectHistorySaved(runtime, projectedHistoryContext());
}
async function resetHistory(runtime: Runtime): Promise<HistoryStatus> {
  return resetProjectHistory(runtime, projectedHistoryContext());
}
export async function recordHistoryContext(
  platform: PlatformCapabilities,
  label: string,
  context: HistoryContext,
): Promise<HistoryStatus> {
  const runtime = runtimeOf(platform);
  return recordProjectHistoryContext(runtime, label, context);
}
async function restoreSystemPresets(runtime: Runtime, selections: ProjectPresetSelections | null): Promise<void> {
  if (!selections) return;
  let resolved: Awaited<ReturnType<Runtime['getProfileSnapshot']>> | null = null;
  for (const [kind, name] of [['printer', selections.printer], ['print', selections.print]] as const) {
    if (!name) continue;
    const result = await runtime.selectProfile(kind, name);
    if (!result.ok) throw new Error(result.error ?? `could not restore ${kind} preset`);
    resolved = result;
  }
  if (resolved?.ok) useSettingsStore.getState().hydrateProfileSnapshot(resolved);
}
async function gateDirty(platform: PlatformCapabilities, operationName: 'new' | 'open', input: ProjectInput | undefined, options: ProjectActionOptions): Promise<ProjectActionResult | null> {
  if (!await projectDirtyStatus(platform)) return null;
  setOperation('waiting-for-dirty-decision');
  const decision = await options.decideDirty?.(operationName, input) ?? 'cancel';
  if (decision === 'cancel') { setOperation('cancelled'); return { status: 'cancelled' }; }
  if (decision === 'dont-save') return null;
  if (useProjectStore.getState().flattenedMultiPlate && options.confirmFlattenedSave) {
    if (!await options.confirmFlattenedSave()) { setOperation('cancelled'); return { status: 'cancelled' }; }
  }
  const saved = await saveProject(platform);
  return saved.status === 'ok' ? null : saved;
}

export async function saveProject(platform: PlatformCapabilities): Promise<ProjectActionResult> {
  const session = useProjectStore.getState(); if (!session.hasContent) return errorResult(new Error('there is no project to save'));
  setOperation('saving', 0, 'Exporting project');
  try {
    const exported = await runtimeOf(platform).exportProject(); if (!exported.ok) throw new Error(exported.error ?? 'project export failed');
    setOperation('saving', 70, 'Writing project');
    const saved = await platform.projects.save({ displayName: `${session.projectName || 'Untitled'}.3mf`, bytes: exported.bytes, location: session.location });
    if (saved.status !== 'ok') { setOperation(saved.status === 'cancelled' ? 'cancelled' : 'failed'); return saved.status === 'cancelled' ? { status: 'cancelled' } : errorResult(saved.error); }
    const history = await markHistorySaved(runtimeOf(platform));
    useProjectStore.getState().setProject({ dirty: history.dirty, dirtyReasons: [], location: saved.location ?? session.location }); setOperation('completed', 100); return { status: 'ok' };
  } catch (error) { setOperation('failed', 0, errorText(error)); return errorResult(error); }
}
export async function saveProjectAs(platform: PlatformCapabilities): Promise<ProjectActionResult> {
  const session = useProjectStore.getState(); if (!session.hasContent) return errorResult(new Error('there is no project to save'));
  setOperation('saving', 0, 'Exporting project');
  try {
    const exported = await runtimeOf(platform).exportProject(); if (!exported.ok) throw new Error(exported.error ?? 'project export failed');
    const saved = await platform.projects.saveAs({ displayName: `${session.projectName || 'Untitled'}.3mf`, bytes: exported.bytes, location: session.location });
    if (saved.status !== 'ok') { setOperation(saved.status === 'cancelled' ? 'cancelled' : 'failed'); return saved.status === 'cancelled' ? { status: 'cancelled' } : errorResult(saved.error); }
    const history = await markHistorySaved(runtimeOf(platform));
    useProjectStore.getState().setProject({ dirty: history?.dirty ?? false, dirtyReasons: [], location: saved.location ?? session.location }); setOperation('completed', 100); return { status: 'ok' };
  } catch (error) { setOperation('failed', 0, errorText(error)); return errorResult(error); }
}
export async function newProject(platform: PlatformCapabilities, options: ProjectActionOptions = {}): Promise<ProjectActionResult> {
  const gate = await gateDirty(platform, 'new', undefined, options); if (gate) return gate;
  const previous = useProjectStore.getState(); setOperation('loading', 0, 'Creating project');
  try {
    if (options.signal?.aborted) { setOperation('cancelled'); return { status: 'cancelled' }; }
    const sourcePrinter = currentPresets().printer;
    const runtime = runtimeOf(platform); const cleared = await runtime.clearModel(); if (!cleared.ok) throw new Error(cleared.error ?? 'new project failed');
    resetSceneState(options.sceneResetTarget, { clearSettings: true });
    usePlateSessionStore.getState().setSnapshot(cleared.plateSession ?? null);
    const global = previous.systemPresets ?? (previous.scope === 'system' ? currentPresets() : null); await restoreSystemPresets(runtime, global);
    const targetPrinter = currentPresets().printer;
    if (targetPrinter !== sourcePrinter) {
      await applyRememberedFilamentRackFromRepository(
        platform.preferences,
        runtime,
        targetPrinter,
      );
    }
    // The active system printer already owns its correctly restored rack.
    // New Project preserves that live rack and only establishes a clean model,
    // plate, and history baseline; it never replays a preference as an edit.
    await resetHistory(runtime);
    const resolved = currentPresets(); useProjectStore.getState().reset(); useProjectStore.getState().setProject({ systemPresets: resolved, hasContent: false }); setOperation('completed', 100); return { status: 'ok' };
  } catch (error) { setOperation('failed', 0, errorText(error)); return errorResult(error); }
}
export async function importProjectGeometry(platform: PlatformCapabilities, input: ProjectInput, options: ProjectActionOptions = {}): Promise<ProjectActionResult> {
  setOperation('loading', 0, 'Importing geometry');
  try {
    if (options.signal?.aborted) { setOperation('cancelled'); return { status: 'cancelled' }; }
    const runtime = runtimeOf(platform);
    const history = await runProjectHistoryMutation(
      runtime,
      'Import Geometry',
      () => runtime.importProjectGeometry(input.bytes, input.displayName, (percent, message) => setOperation('loading', percent, message)),
      null,
      {
        publish: async (published) => {
          if (!published.ok) throw new Error(published.error ?? 'geometry import failed');
          applyPlateSessionTransforms(published.plateSession, glVolumeCollection.volumes);
          invalidateInput();
          const existing = useProjectStore.getState();
          const incomingNotices = noticesFor(published);
          const notices = [...existing.notices, ...incomingNotices.filter((notice) => !existing.notices.some((current) => current.kind === notice.kind))];
          if (published.plateSession) {
            usePlateSessionStore.getState().setSnapshot(published.plateSession);
            useProjectStore.getState().recordPlateMutation(published.plateSession);
          }
          else useProjectStore.getState().markDirty('model-import');
          useProjectStore.getState().setProject({ ...(options.preserveSessionIdentity ? {} : { projectName: 'Untitled', location: undefined }), hasContent: true, notices, flattenedMultiPlate: false, scope: existing.scope });
          useSettingsStore.getState().setModelLoaded(true);
        },
      },
    );
    const load = history.result;
    if (!load.ok) throw new Error(load.error ?? 'geometry import failed');
    setOperation('completed', 100); return { status: 'ok', load };
  } catch (error) { setOperation('failed', 0, errorText(error)); return errorResult(error); }
}
async function openProjectInput(platform: PlatformCapabilities, input: ProjectInput, options: ProjectActionOptions): Promise<ProjectActionResult> {
  let behaviour = options.loadBehaviour;
  if (!behaviour) {
    try { behaviour = (await platform.preferences.load()).projectLoadBehaviour; } catch (error) { console.warn('project load preference unavailable; using Ask When Relevant', error); }
  }
  behaviour ??= 'ask_when_relevant';
  let choice: ProjectLoadChoice = behaviour === 'load_geometry_only' ? 'geometry-only' : 'project';
  if (shouldAskProjectLoad(behaviour, useSettingsStore.getState().modelLoaded)) { setOperation('waiting-for-load-choice'); choice = await options.chooseLoad?.(input) ?? 'cancel'; if (choice === 'cancel') { setOperation('cancelled'); return { status: 'cancelled' }; } }
  if (choice === 'geometry-only') return importProjectGeometry(platform, input, options);
  const gate = await gateDirty(platform, 'open', input, options); if (gate) return gate;
  setOperation('loading', 0, 'Opening project');
  try {
    if (options.signal?.aborted) { setOperation('cancelled'); return { status: 'cancelled' }; }
    const previous = useProjectStore.getState(); const system = previous.systemPresets ?? (previous.scope === 'system' ? currentPresets() : null);
    const runtime = runtimeOf(platform);
    const publishClosedProject = (plateSession: PlateSessionMutation) => {
      resetSceneState(options.sceneResetTarget, { clearSettings: true });
      usePlateSessionStore.getState().setSnapshot(plateSession);
      useProjectStore.getState().reset();
      useProjectStore.getState().setProject({ systemPresets: system, hasContent: false });
    };
    const load = await runtime.loadProject(input.bytes, 'project', input.displayName,
      (percent, message) => setOperation('loading', percent, message), publishClosedProject);
    const commitRoute: ProjectLoadCommitRoute = 'load-project';
    if (!load.ok) throw new Error(load.error ?? 'project load failed');
    const warning = load.embeddedPresetWarnings;
    const needsConfirmation = warning?.requiresConfirmation === true ||
      (warning?.filamentSlotChanges?.length ?? 0) > 0;
    if (needsConfirmation) {
      setOperation('waiting-for-project-confirmation', 100, 'Review project compatibility');
      let accepted = false;
      try {
        accepted = await options.confirmProjectLoad?.(load) ?? false;
      } catch (error) {
        const closed = await runtime.closeProject();
        if (closed.ok && closed.plateSession) publishClosedProject(closed.plateSession);
        throw error;
      }
      if (!accepted) {
        const closed = await runtime.closeProject();
        if (!closed.ok) throw new Error(closed.error ?? 'project close failed');
        if (closed.plateSession) publishClosedProject(closed.plateSession);
        setOperation('cancelled');
        return { status: 'cancelled', load };
      }
    }
    applyPlateSessionTransforms(load.plateSession, glVolumeCollection.volumes);
    if (load.plateSession) usePlateSessionStore.getState().setSnapshot(load.plateSession);
    // The native load response contains the candidate preset snapshot from
    // the same replacement transaction. A second getProfileSnapshot call here
    // could fail after native state changed and leave the UI inconsistent.
    const snapshot = load.presetSnapshot; if (!snapshot) throw new Error('project load did not return its preset snapshot');
    useSettingsStore.getState().hydrateProfileSnapshot(snapshot);
    useSettingsStore.getState().setOverlay(load.projectConfigOverlay ?? emptyProjectConfigOverlay());
    useSettingsStore.getState().setModelLoaded(true); invalidateInput();
    const history = await resetHistory(runtime);
    useProjectStore.getState().setProject({ projectName: projectNameFromDisplayName(input.displayName), location: input.location, hasContent: true, dirty: history.dirty, dirtyReasons: [], scope: 'project', systemPresets: system, projectPresets: projectPresetSelections(snapshot), notices: noticesFor(load), flattenedMultiPlate: false });
    setOperation('completed', 100);
    return {
      status: 'ok',
      load,
      loadReceipt: {
        sourceDisplayName: input.displayName,
        sourceByteLength: input.bytes.byteLength,
        commitRoute,
        nativeResult: load,
      },
    };
  } catch (error) { setOperation('failed', 0, errorText(error)); return errorResult(error); }
}

const MODEL_EXTENSIONS = new Set(['3mf', 'stl', 'obj', 'drc', 'amf', 'ply']);
const UNSUPPORTED_EXTENSIONS = new Set(['gcode', 'bgcode', 'sl1', 'sl1s', 'sliced']);
function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}
function hasUnsupportedResultSuffix(name: string): boolean {
  return /\.(?:gcode|bgcode)\.3mf$/i.test(name.split(/[\\/]/).pop() ?? name);
}
export function sortProjectInputs(inputs: readonly ProjectInput[]): ProjectInput[] {
  return [...inputs].sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }) || a.displayName.localeCompare(b.displayName));
}
/** Reject the whole batch before invoking WASM, so unsupported mixed drops are atomic. */
export function validateProjectInputs(inputs: readonly ProjectInput[]): string | null {
  if (inputs.length === 0) return 'no project files were selected';
  for (const input of inputs) {
    if (hasUnsupportedResultSuffix(input.displayName)) return `${input.displayName} is an unsupported sliced-result or G-code file`;
    const extension = extensionOf(input.displayName);
    if (UNSUPPORTED_EXTENSIONS.has(extension)) return `${input.displayName} is an unsupported sliced-result or G-code file`;
    if (!MODEL_EXTENSIONS.has(extension)) return `${input.displayName} is not a supported model or 3MF project file`;
  }
  if (!inputs.some((input) => extensionOf(input.displayName) === '3mf')) return 'Open Project requires at least one .3mf file';
  return null;
}

/** Shared project action entry point for picker batches and drag/drop batches. */
export async function openProjectInputs(platform: PlatformCapabilities, inputs: readonly ProjectInput[], options: ProjectActionOptions = {}): Promise<ProjectActionResult> {
  const ordered = sortProjectInputs(inputs);
  const invalid = validateProjectInputs(ordered);
  if (invalid) { setOperation('failed', 0, invalid); return errorResult(new Error(invalid)); }
  // The first 3MF is the only candidate for replacement. Other files are
  // deliberately deferred until that decision/load succeeds.
  const firstIndex = ordered.findIndex((input) => extensionOf(input.displayName) === '3mf');
  const first = ordered[firstIndex];
  const result = await openProjectInput(platform, first, options);
  if (result.status !== 'ok') return result;
  const remainder = [...ordered.slice(0, firstIndex), ...ordered.slice(firstIndex + 1)];
  for (const input of remainder) {
    const imported = await importProjectGeometry(platform, input, { ...options, preserveSessionIdentity: true });
    if (imported.status !== 'ok') return imported;
  }
  return result;
}

export async function openProject(platform: PlatformCapabilities, options: ProjectActionOptions = {}): Promise<ProjectActionResult> {
  if (options.inputs) return openProjectInputs(platform, options.inputs, options);
  const picked = platform.projects.openMany ? await platform.projects.openMany() : await platform.projects.open();
  if (picked.status === 'cancelled') { setOperation('cancelled'); return { status: 'cancelled' }; }
  if (picked.status === 'failed') { setOperation('failed'); return errorResult(picked.error); }
  return 'inputs' in picked
    ? openProjectInputs(platform, picked.inputs, options)
    : openProjectInput(platform, picked.input, options);
}

/** UI-independent cancellation hook for the progress dialog/action surface. */
export async function cancelProjectOperation(platform: PlatformCapabilities): Promise<ProjectActionResult> {
  try {
    const result = await runtimeOf(platform).cancel();
    if (!result.ok) throw new Error(result.error ?? 'project operation cancellation failed');
    setOperation('cancelled');
    return { status: 'cancelled' };
  } catch (error) {
    setOperation('failed', 0, errorText(error));
    return errorResult(error);
  }
}
