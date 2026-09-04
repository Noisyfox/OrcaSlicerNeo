import type { PlatformCapabilities, ProjectInput } from '@orca/platform-contract';
import type { ProjectLoadResult, SlicerClient } from '@slicer/client';
import { compatibilityFallback, projectNameFromDisplayName, shouldAskProjectLoad, type DirtyProjectDecision, type ProjectLoadChoice } from '../../slicer-runtime/src/projectSession';
import { useProjectStore, projectPresetTriple, type ProjectNotice, type ProjectPresetSelections } from './stores/useProjectStore';
import { useSettingsStore } from './stores/useSettingsStore';
import { useSlicerStore } from './stores/useSlicerStore';

export interface ProjectActionOptions {
  loadBehaviour?: 'load_all' | 'ask_when_relevant' | 'always_ask' | 'load_geometry_only';
  chooseLoad?: (input: ProjectInput) => Promise<ProjectLoadChoice> | ProjectLoadChoice;
  decideDirty?: (operation: 'new' | 'open', input?: ProjectInput) => Promise<DirtyProjectDecision> | DirtyProjectDecision;
  signal?: AbortSignal;
}
export interface ProjectActionResult { status: 'ok' | 'cancelled' | 'failed'; error?: unknown; load?: ProjectLoadResult; }
type Runtime = Pick<SlicerClient, 'loadProject' | 'importProjectGeometry' | 'clearModel' | 'exportProject' | 'getPresetSnapshot' | 'selectPreset' | 'cancel'>;

function errorResult(error: unknown): ProjectActionResult { return { status: 'failed', error }; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function runtimeOf(platform: PlatformCapabilities): Runtime { return platform.runtime; }
function currentPresets(): ProjectPresetSelections {
  const s = useSettingsStore.getState(); return { printer: s.selectedPrinter, print: s.selectedPrint, filament: s.selectedFilament };
}
function noticesFor(load: ProjectLoadResult): ProjectNotice[] {
  const notices: ProjectNotice[] = [];
  const fallback = compatibilityFallback(load); if (fallback) notices.push({ kind: 'compatibility-fallback', message: fallback });
  if (load.multiPlate) notices.push({ kind: 'multi-plate', message: `This project has ${load.plateCount ?? 0} plates and will be flattened into one scene.` });
  if (load.embeddedPresetWarnings?.present) notices.push({ kind: 'embedded-presets', message: 'This project contains embedded preset settings that may differ from system presets.', details: load.embeddedPresetWarnings });
  return notices;
}
function setOperation(phase: Parameters<ReturnType<typeof useProjectStore.getState>['setOperation']>[0]['phase'], progress = 0, message?: string): void {
  useProjectStore.getState().setOperation({ phase, progress, message, cancellable: phase === 'loading' || phase === 'saving' });
}
function invalidateInput(): void { useSlicerStore.getState().invalidateSliceResult(); }
async function restoreSystemPresets(runtime: Runtime, selections: ProjectPresetSelections | null): Promise<void> {
  if (!selections) return;
  let resolved: Awaited<ReturnType<Runtime['getPresetSnapshot']>> | null = null;
  for (const [kind, name] of [['printer', selections.printer], ['print', selections.print], ['filament', selections.filament]] as const) {
    if (!name) continue;
    const result = await runtime.selectPreset(kind, name);
    if (!result.ok) throw new Error(result.error ?? `could not restore ${kind} preset`);
    resolved = result;
  }
  if (resolved?.ok) useSettingsStore.getState().hydratePresetSnapshot(resolved);
}
async function gateDirty(platform: PlatformCapabilities, operationName: 'new' | 'open', input: ProjectInput | undefined, options: ProjectActionOptions): Promise<ProjectActionResult | null> {
  if (!useProjectStore.getState().dirty) return null;
  setOperation('waiting-for-dirty-decision');
  const decision = await options.decideDirty?.(operationName, input) ?? 'cancel';
  if (decision === 'cancel') { setOperation('cancelled'); return { status: 'cancelled' }; }
  if (decision === 'dont-save') return null;
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
    useProjectStore.getState().setProject({ dirty: false, location: saved.location ?? session.location }); setOperation('completed', 100); return { status: 'ok' };
  } catch (error) { setOperation('failed', 0, errorText(error)); return errorResult(error); }
}
export async function saveProjectAs(platform: PlatformCapabilities): Promise<ProjectActionResult> {
  const session = useProjectStore.getState(); if (!session.hasContent) return errorResult(new Error('there is no project to save'));
  setOperation('saving', 0, 'Exporting project');
  try {
    const exported = await runtimeOf(platform).exportProject(); if (!exported.ok) throw new Error(exported.error ?? 'project export failed');
    const saved = await platform.projects.saveAs({ displayName: `${session.projectName || 'Untitled'}.3mf`, bytes: exported.bytes, location: session.location });
    if (saved.status !== 'ok') { setOperation(saved.status === 'cancelled' ? 'cancelled' : 'failed'); return saved.status === 'cancelled' ? { status: 'cancelled' } : errorResult(saved.error); }
    useProjectStore.getState().setProject({ dirty: false, location: saved.location ?? session.location }); setOperation('completed', 100); return { status: 'ok' };
  } catch (error) { setOperation('failed', 0, errorText(error)); return errorResult(error); }
}
export async function newProject(platform: PlatformCapabilities, options: ProjectActionOptions = {}): Promise<ProjectActionResult> {
  const gate = await gateDirty(platform, 'new', undefined, options); if (gate) return gate;
  const previous = useProjectStore.getState(); setOperation('loading', 0, 'Creating project');
  try {
    if (options.signal?.aborted) { setOperation('cancelled'); return { status: 'cancelled' }; }
    const runtime = runtimeOf(platform); const cleared = await runtime.clearModel(); if (!cleared.ok) throw new Error(cleared.error ?? 'new project failed');
    const global = previous.systemPresets ?? (previous.scope === 'system' ? currentPresets() : null); await restoreSystemPresets(runtime, global);
    invalidateInput(); const resolved = currentPresets(); useProjectStore.getState().reset(); useProjectStore.getState().setProject({ systemPresets: resolved, hasContent: false }); setOperation('completed', 100); return { status: 'ok' };
  } catch (error) { setOperation('failed', 0, errorText(error)); return errorResult(error); }
}
export async function importProjectGeometry(platform: PlatformCapabilities, input: ProjectInput, options: ProjectActionOptions = {}): Promise<ProjectActionResult> {
  setOperation('loading', 0, 'Importing geometry');
  try {
    if (options.signal?.aborted) { setOperation('cancelled'); return { status: 'cancelled' }; }
    const load = await runtimeOf(platform).importProjectGeometry(input.bytes, input.displayName); if (!load.ok) throw new Error(load.error ?? 'geometry import failed');
    invalidateInput(); const existing = useProjectStore.getState(); useProjectStore.getState().setProject({ projectName: 'Untitled', location: undefined, hasContent: true, dirty: true, notices: noticesFor(load), flattenedMultiPlate: load.multiPlate === true, scope: existing.scope }); useSettingsStore.getState().setModelLoaded(true); setOperation('completed', 100); return { status: 'ok', load };
  } catch (error) { setOperation('failed', 0, errorText(error)); return errorResult(error); }
}
export async function openProject(platform: PlatformCapabilities, options: ProjectActionOptions = {}): Promise<ProjectActionResult> {
  const picked = await platform.projects.open();
  if (picked.status === 'cancelled') { setOperation('cancelled'); return { status: 'cancelled' }; }
  if (picked.status === 'failed') { setOperation('failed'); return errorResult(picked.error); }
  const input = picked.input;
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
    const load = await runtimeOf(platform).loadProject(input.bytes, 'project', input.displayName); if (!load.ok) throw new Error(load.error ?? 'project load failed');
    const snapshot = await runtimeOf(platform).getPresetSnapshot(); if (!snapshot.ok) throw new Error(snapshot.error ?? 'project preset snapshot failed');
    useSettingsStore.getState().hydratePresetSnapshot(snapshot); useSettingsStore.getState().setModelLoaded(true); invalidateInput(); useProjectStore.getState().setProject({ projectName: projectNameFromDisplayName(input.displayName), location: input.location, hasContent: true, dirty: false, scope: 'project', systemPresets: system, projectPresets: projectPresetTriple(snapshot), notices: noticesFor(load), flattenedMultiPlate: load.multiPlate === true }); setOperation('completed', 100); return { status: 'ok', load };
  } catch (error) { setOperation('failed', 0, errorText(error)); return errorResult(error); }
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
