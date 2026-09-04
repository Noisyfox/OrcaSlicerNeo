// packages/slicer-app/src/App.tsx (boot effect: app config load → worker
// client init → atomic preset snapshot → option metadata → settings store)
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from './components/layout/AppShell';
import { TitleBar } from './components/layout/TitleBar';
import { Toolbar } from './components/layout/Toolbar';
import { isWorkspaceTab, type AppTab } from './components/layout/appTabs';
import { Workspace, type PreviewRenderTransition } from './components/workspace/Workspace';
import { DevicePanel } from './components/device/DevicePanel';
import { StatusBar } from './components/layout/StatusBar';
import { useSettingsStore } from './stores/useSettingsStore';
import { useSlicerStore } from './stores/useSlicerStore';
import { useProjectStore } from './stores/useProjectStore';
import type { SceneInteractionController } from './components/workspace/viewport/SceneInteractionController';
import type { WorkspaceSliceCoordinator } from './components/workspace/sliceCoordinator';
import { usePlatform } from '@orca/platform-contract';
import { persistRestoredSelections, restoreSelections } from './preferences';
import { addModel, clearScene } from './components/workspace/actions/sceneActions';
import { exportGcode, sliceModel } from './components/workspace/actions/sliceActions';
import { createCommandDispatcher, registerNativeMenuCommands } from './menu/commands';
import { buildMenuModel, buildMenuStateSnapshot, resolveMenuMode } from './menu/menuModel';
import {
  DirtyProjectDialog,
  ProjectLoadChoiceDialog,
  ProjectNoticeDialog,
  ProjectPreferencesDialog,
  ProjectProgressDialog,
} from './components/project/ProjectDialogs';
import { cancelProjectOperation, newProject, openProject, saveProject, saveProjectAs } from './projectActions';
import type { DirtyProjectDecision, ProjectLoadChoice } from '@orca/slicer-runtime';
import type { ProjectInput, ProjectLoadBehaviour, UserPreferences } from '@orca/platform-contract';

export default function App() {
  const platform = usePlatform();
  const setMetadata = useSettingsStore((s) => s.setMetadata);
  const hydratePresetSnapshot = useSettingsStore((s) => s.hydratePresetSnapshot);
  const setError = useSlicerStore((s) => s.setError);
  const modelLoaded = useSettingsStore((s) => s.modelLoaded);
  const values = useSettingsStore((s) => s.values);
  const status = useSlicerStore((s) => s.status);
  const progress = useSlicerStore((s) => s.progress);
  const slicerError = useSlicerStore((s) => s.error);
  const resultExported = useSlicerStore((s) => s.resultExported);
  const projectState = useProjectStore((s) => s);
  const [boot, setBoot] = useState<'starting' | 'ready' | 'failed'>('starting');
  const [bootError, setBootError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>('home');
  const [prewarmingWorkspace, setPrewarmingWorkspace] = useState(false);
  const [dialog, setDialog] = useState<'load-choice' | 'dirty' | 'preferences' | 'flatten' | 'notice' | null>(null);
  const [loadInput, setLoadInput] = useState<ProjectInput | null>(null);
  const [dirtyOperation, setDirtyOperation] = useState<'new' | 'open'>('open');
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [extraNotice, setExtraNotice] = useState<string | null>(null);
  const loadChoiceResolver = useRef<((choice: ProjectLoadChoice) => void) | null>(null);
  const dirtyResolver = useRef<((decision: DirtyProjectDecision) => void) | null>(null);
  const flattenResolver = useRef<((confirmed: boolean) => void) | null>(null);
  const previewTransitionRef = useRef<PreviewRenderTransition | null>(null);
  const handleTabChange = useCallback((tab: AppTab) => {
    if (tab !== 'preview') {
      previewTransitionRef.current?.cancel();
      setPrewarmingWorkspace(false);
      setActiveTab(tab);
      return;
    }
    if (tab === 'preview' && !isWorkspaceTab(activeTab)) {
      const transition = previewTransitionRef.current;
      if (transition) {
        setPrewarmingWorkspace(true);
        transition.begin();
        return;
      }
    }
    setActiveTab(tab);
  }, [activeTab]);
  const navigateToPreview = useCallback(() => {
    handleTabChange('preview');
  }, [handleTabChange]);
  const handlePreviewTransitionChange = useCallback((transition: PreviewRenderTransition | null) => {
    previewTransitionRef.current = transition;
  }, []);
  const completePreviewTransition = useCallback(() => {
    setPrewarmingWorkspace(false);
    setActiveTab('preview');
  }, []);
  // Workspace owns the controller; the dispatcher only ever reads it lazily at
  // dispatch time, so mirroring it into a ref keeps App out of the re-render.
  const sceneInteractionRef = useRef<SceneInteractionController | null>(null);
  const handleSceneInteractionChange = useCallback((controller: SceneInteractionController | null) => {
    sceneInteractionRef.current = controller;
  }, []);
  const workspaceSliceCoordinatorRef = useRef<WorkspaceSliceCoordinator | null>(null);
  const handleSliceCoordinatorChange = useCallback((coordinator: WorkspaceSliceCoordinator | null) => {
    workspaceSliceCoordinatorRef.current = coordinator;
  }, []);
  const requestPreviewSlice = useCallback(() => {
    const coordinator = workspaceSliceCoordinatorRef.current;
    if (coordinator) return coordinator.requestPreviewSlice();
    // The Workspace is always mounted once the shell is ready, but preserve a
    // safe fallback for an early host callback during React effect setup.
    navigateToPreview();
    return sliceModel(platform);
  }, [navigateToPreview, platform]);

  const chooseLoad = useCallback((input: ProjectInput) => new Promise<ProjectLoadChoice>((resolve) => {
    setLoadInput(input); loadChoiceResolver.current = resolve; setDialog('load-choice');
  }), []);
  const decideDirty = useCallback((operation: 'new' | 'open') => new Promise<DirtyProjectDecision>((resolve) => {
    setDirtyOperation(operation); dirtyResolver.current = resolve; setDialog('dirty');
  }), []);
  const confirmFlatten = useCallback(() => new Promise<boolean>((resolve) => {
    flattenResolver.current = resolve; setDialog('flatten');
  }), []);
  const reportProjectFailure = useCallback((result: { status: string; error?: unknown }) => {
    if (result.status === 'failed') {
      const message = result.error instanceof Error ? result.error.message : String(result.error ?? '');
      if (/g.?code|sliced.?result|embedded/i.test(message)) setExtraNotice('3MF files containing embedded G-code or a sliced-result package are unsupported. The current project was left unchanged.');
      else setError(message);
    }
  }, [setError]);
  const runNewProject = useCallback(async () => {
    const result = await newProject(platform, { decideDirty, confirmFlattenedSave: confirmFlatten });
    reportProjectFailure(result);
    if (result.status === 'ok') setActiveTab('prepare');
  }, [confirmFlatten, decideDirty, platform, reportProjectFailure]);
  const runOpenProject = useCallback(async () => {
    const result = await openProject(platform, { chooseLoad, decideDirty, confirmFlattenedSave: confirmFlatten });
    reportProjectFailure(result);
    if (result.status === 'ok') { setActiveTab('prepare'); setDialog(null); }
  }, [chooseLoad, confirmFlatten, decideDirty, platform, reportProjectFailure]);
  const runImportGeometry = useCallback(async () => {
    await addModel(platform, sceneInteractionRef.current);
  }, [platform]);
  const runSaveProject = useCallback(async (asCopy = false) => {
    if (projectState.flattenedMultiPlate) {
      setDialog(null);
      const confirmed = await confirmFlatten();
      if (!confirmed) return;
    }
    const result = asCopy ? await saveProjectAs(platform) : await saveProject(platform);
    reportProjectFailure(result);
  }, [confirmFlatten, platform, projectState.flattenedMultiPlate, reportProjectFailure]);
  const openPreferences = useCallback(async () => {
    try { setPreferences(await platform.preferences.load()); } catch { setPreferences(null); }
    setDialog('preferences');
  }, [platform.preferences]);
  const savePreferences = useCallback(async (behaviour: ProjectLoadBehaviour) => {
    const current = preferences ?? await platform.preferences.load();
    const next = { ...current, projectLoadBehaviour: behaviour };
    setPreferences(next);
    await platform.preferences.save(next);
  }, [platform.preferences, preferences]);

  const menuState = useMemo(() => buildMenuStateSnapshot({
    version: 1,
    activeTab,
    boot: { phase: boot, error: bootError },
    slicer: { status, progress, error: slicerError },
    scene: { hasModel: modelLoaded },
    result: { hasResult: status === 'done', exported: resultExported },
    project: {
      hasContent: projectState.hasContent,
      dirty: projectState.dirty,
      flattenedMultiPlate: projectState.flattenedMultiPlate,
      operation: {
        phase: projectState.operation.phase,
        progress: projectState.operation.progress / 100,
        message: projectState.operation.message,
        cancellable: projectState.operation.cancellable,
      },
    },
    host: {
      isElectron: platform.chrome.kind === 'desktop',
      menuMode: resolveMenuMode(platform.chrome),
    },
  }, platform.chrome), [
    boot,
    activeTab,
    bootError,
    modelLoaded,
    platform.chrome,
    progress,
    resultExported,
    slicerError,
    status,
    projectState,
  ]);
  const menuModel = useMemo(
    () => buildMenuModel(menuState, platform.chrome),
    [menuState, platform.chrome],
  );
  const menuStateRef = useRef(menuState);
  menuStateRef.current = menuState;
  const dispatcher = useMemo(() => createCommandDispatcher({
    getSnapshot: () => menuStateRef.current,
    actions: {
      newProject: runNewProject,
      openProject: runOpenProject,
      importGeometry: runImportGeometry,
      saveProject: () => runSaveProject(false),
      saveProjectAs: () => runSaveProject(true),
      preferences: openPreferences,
      addModel: () => addModel(platform, sceneInteractionRef.current),
      clearScene: () => clearScene(platform, sceneInteractionRef.current),
      slice: requestPreviewSlice,
      exportGcode: () => exportGcode(platform),
      openSource: async () => { await platform.externalLinks.openSource(); },
      quit: async () => { await platform.menu.execute('quit'); },
    },
  }), [openPreferences, platform, requestPreviewSlice, runImportGeometry, runNewProject, runOpenProject, runSaveProject]);

  // Strict Mode replays layout effects during development. Keep activation
  // and disposal next to the native subscription so replay cannot leave the
  // memoized dispatcher permanently inactive.
  useLayoutEffect(() => {
    dispatcher.activate();
    const unregister = registerNativeMenuCommands(platform, dispatcher);
    return () => {
      unregister();
      dispatcher.dispose();
    };
  }, [dispatcher, platform]);
  useLayoutEffect(() => {
    void Promise.resolve(platform.menu.syncModel(menuModel)).catch((error) => {
      console.error('menu model sync failed:', error);
    });
    void Promise.resolve(platform.menu.syncState(menuState)).catch((error) => {
      console.error('menu state sync failed:', error);
    });
  }, [menuModel, menuState, platform.menu]);

  // Keyboard accelerators are owned by the shared app so browser and Electron
  // surfaces dispatch exactly the same guarded command. Prevent the browser's
  // native tab/page actions even when the command is currently disabled.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      const command = key === 'n' ? 'new-project'
        : key === 'o' ? 'open-project'
          : key === 's' && event.shiftKey ? 'save-project-as'
            : key === 's' ? 'save-project' : null;
      if (!command) return;
      event.preventDefault();
      void dispatcher.dispatch(command);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [dispatcher]);
  useEffect(() => {
    if (projectState.notices.length > 0) setDialog('notice');
  }, [projectState.notices]);
  const titleBar = (
    <TitleBar
      chrome={platform.chrome}
      model={menuModel}
      state={menuState}
      onCommand={(command) => { void dispatcher.dispatch(command); }}
    />
  );

  // The app's only context menus are the 3D scene's own menu
  // (SceneContextMenu, right-click on empty viewport space) and the native
  // copy/paste menus on editable controls. Right-clicking empty space outside
  // any editor — the toolbar row, settings sidebar, status bar — must not
  // surface the browser/host default menu.
  useEffect(() => {
    const suppressEmptySpaceContextMenu = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Editable controls keep the native menu (copy/paste, spellcheck). Stop
      // propagation as well as leaving default behavior intact, so a nested
      // ContextMenuTrigger cannot consume the gesture after this guard runs.
      if (target.closest('input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])')) {
        event.stopPropagation();
        return;
      }
      // The WebGL viewport owns its own scene context menu.
      if (target.closest('canvas[data-engine^="three.js"]')) return;
      event.preventDefault();
    };
    document.addEventListener('contextmenu', suppressEmptySpaceContextMenu, true);
    return () => document.removeEventListener('contextmenu', suppressEmptySpaceContextMenu, true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setBoot('starting');
        const preferences = await platform.preferences.load();
        const init = await platform.runtime.init();
        if (!init.ok) throw new Error(init.error ?? 'orc_init failed');
        const metadata = await platform.runtime.getOptionMetadata();
        // Restore only names; compatibility and defaults remain authoritative
        // in the C++ preset bundle. The bridge response is written back so a
        // missing/corrupt selection is healed for the next boot.
        const restored = await restoreSelections(platform.runtime, preferences);
        if (cancelled) return;
        await persistRestoredSelections(platform.preferences, restored.preferences);
        if (cancelled) return;
        hydratePresetSnapshot(restored.snapshot);
        useProjectStore.getState().setProject({
          systemPresets: {
            printer: restored.snapshot.printer.name,
            print: restored.snapshot.print.name,
            filament: restored.snapshot.filament.name,
          },
        });
        setMetadata(metadata);
        setBoot('ready');
      } catch (err) {
        if (!cancelled) {
          const message = String(err);
          setBootError(message);
          setBoot('failed');
          setError(`boot: ${message}`);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [hydratePresetSnapshot, setMetadata, setError, platform.preferences, platform.runtime]);

  useEffect(() => {
    if (platform.chrome.kind !== 'web') return;
    const protect = (event: BeforeUnloadEvent) => {
      const hasOverrides = Object.keys(values).some((key) => key !== 'modelPath');
      const hasUnexportedResult = status === 'done' && !resultExported;
      if (!modelLoaded && !hasOverrides && !hasUnexportedResult) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [platform.chrome.kind, modelLoaded, resultExported, status, values]);

  // Keep the shared application inert until the worker has initialized the
  // core and every profile package has been installed. This is intentionally
  // host-neutral: Electron and Web must expose the same startup contract and
  // must never allow a user action against a partially populated MEMFS.
  if (boot !== 'ready') {
    // The window is frameless on desktop, so the startup screen must carry
    // the title bar too — otherwise there is no drag region to move the
    // window while the runtime loads (see doc/2026-08-15-frameless-window.md).
    return (
      <div className="flex h-full flex-col bg-background" data-testid="startup-screen">
        {titleBar}
        <main className="flex flex-1 items-center justify-center">
          <section className="w-full max-w-lg space-y-3 rounded-md border bg-card p-8 shadow-sm">
            <h1 className="text-xl font-semibold">OrcaSlicerNeo</h1>
            {boot === 'failed' ? (
              <>
                <h2 className="text-destructive">Startup failed</h2>
                <p className="break-words text-sm text-muted-foreground" data-testid="startup-error">{bootError}</p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground" data-testid="startup-progress">Loading slicer runtime and profiles…</p>
            )}
          </section>
        </main>
      </div>
    );
  }

  const notices = extraNotice
    ? [{ kind: 'compatibility-fallback' as const, message: extraNotice }]
    : projectState.notices;
  return (
    <>
      <AppShell
        titleBar={titleBar}
        toolbar={<Toolbar activeTab={activeTab} onTabChange={handleTabChange} onNavigateToDevice={() => handleTabChange('device')} onSlice={requestPreviewSlice} />}
        activeTab={activeTab}
        prewarmWorkspace={prewarmingWorkspace}
        home={<div data-testid="home-page" />}
        workspace={<Workspace activeTab={activeTab} onSceneInteractionChange={handleSceneInteractionChange} onSliceCoordinatorChange={handleSliceCoordinatorChange} onRequestPreview={navigateToPreview} onPreviewTransitionChange={handlePreviewTransitionChange} onPreviewRenderReady={completePreviewTransition} />}
        device={<DevicePanel />}
        status={<StatusBar />}
      />
      <ProjectLoadChoiceDialog
        open={dialog === 'load-choice'}
        input={loadInput}
        onChoice={(choice) => { loadChoiceResolver.current?.(choice); loadChoiceResolver.current = null; setDialog(null); }}
        onCancel={() => { loadChoiceResolver.current?.('cancel'); loadChoiceResolver.current = null; setDialog(null); }}
      />
      <DirtyProjectDialog
        open={dialog === 'dirty'}
        operation={dirtyOperation}
        onDecision={(decision) => { dirtyResolver.current?.(decision); dirtyResolver.current = null; setDialog(null); }}
      />
      <ProjectPreferencesDialog
        open={dialog === 'preferences'}
        preferences={preferences}
        onSave={savePreferences}
        onClose={() => setDialog(null)}
      />
      <ProjectNoticeDialog
        open={dialog === 'notice' && notices.length > 0}
        notices={notices}
        onClose={() => { setDialog(null); setExtraNotice(null); }}
      />
      <ProjectNoticeDialog
        notices={projectState.flattenedMultiPlate && dialog === 'flatten' ? [{ kind: 'multi-plate', message: 'This project contains multiple plates. Saving will flatten it into a single-plate project.' }] : []}
        title="Flatten project before saving?"
        testId="project-flatten-dialog"
        onClose={() => { flattenResolver.current?.(false); flattenResolver.current = null; setDialog(null); }}
        onContinue={() => { flattenResolver.current?.(true); flattenResolver.current = null; setDialog(null); }}
      />
      <ProjectProgressDialog
        operation={projectState.operation}
        onCancel={() => { void cancelProjectOperation(platform); }}
      />
    </>
  );
}
