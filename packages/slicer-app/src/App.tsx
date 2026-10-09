import { paintingCommandAllowed, closePaintingForCommand, paintingSessionActive } from './components/workspace/viewport/gizmo/painting/projectCommands';
// packages/slicer-app/src/App.tsx (boot effect: app config load → worker
// client init → atomic preset snapshot → option metadata → settings store)
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { AppShell } from './components/layout/AppShell';
import { TitleBar } from './components/layout/TitleBar';
import { SliceButton } from './components/workspace/SliceButton';
import { isPrepareTab, isWorkspaceTab, type AppTab } from './components/layout/appTabs';
import { Workspace, type PreviewRenderTransition } from './components/workspace/Workspace';
import { DevicePanel } from './components/device/DevicePanel';
import { StatusBar } from './components/layout/StatusBar';
import { useSettingsStore } from './stores/useSettingsStore';
import { useSlicerStore } from './stores/useSlicerStore';
import { useProjectStore } from './stores/useProjectStore';
import type { SceneInteractionController } from './components/workspace/viewport/SceneInteractionController';
import type { WorkspaceSliceCoordinator } from './components/workspace/sliceCoordinator';
import type { HistoryRestoreCoordinator } from './history/restoreCoordinator';
import { updateUserPreferences, usePlatform } from '@orca/platform-contract';
import { persistRestoredSelections, restoreBootstrapSession } from './preferences';
import { useFilamentSessionStore } from './stores/useFilamentSessionStore';
import { addDroppedModels, addModel, clearScene } from './components/workspace/actions/sceneActions';
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
import { cancelProjectOperation, newProject, noticesFor, openProject, projectDirtyStatus, saveProject, saveProjectAs, type ProjectLoadReceipt } from './projectActions';
import { errorText } from '@orca/slicer-runtime';
import type { DirtyProjectDecision, ProjectLoadChoice } from '@orca/slicer-runtime';
import type { ProjectInput, ProjectLoadBehaviour, UserPreferences } from '@orca/platform-contract';
import type { HistoryContext, ProjectLoadResult } from '@slicer/client';
import { registerProjectDropHandlers } from './dropHandling';
import { useHistoryNavigationStore } from './stores/useHistoryNavigationStore';
import { historyNavigationIntentAllowed, historyShortcutAction, isEditableHistoryTarget } from './history/historyNavigation';
import { isSerialSliceBusy } from './runtimeExecution';
import { useHistoryRestoreStore } from './stores/useHistoryRestoreStore';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppE2eProbe } from './e2e/AppE2eProbe';
import { FileManagerWindow } from './components/fileManager/FileManagerWindow';
import { usePaintingPhase, PaintingProvider } from './components/workspace/viewport/gizmo/painting/PaintingProvider';
import { useArrangementStore } from './stores/useArrangementStore';
import { ArrangementEditBoundary } from './components/workspace/ArrangementEditBoundary';
import { useSetupWizardStore } from './stores/useSetupWizardStore';
import { SetupWizard } from './components/project/SetupWizard';
import { publishSetupWizardApplication } from './setupWizardPublication';
import type { SetupCompletionResult } from './setupWizard';
import { ArrangementStatus } from './components/workspace/arrangement/ArrangementControls';

declare const __ORCA_E2E__: boolean;

export function handleMenuKeyDown(
  event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'key' | 'shiftKey' | 'preventDefault'>,
  dispatcher: Pick<ReturnType<typeof createCommandDispatcher>, 'dispatch'>,
): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  const key = event.key.toLowerCase();
  const command = key === 'n' ? 'new-project'
    : key === 'o' ? 'open-project'
      : key === 's' && event.shiftKey ? 'save-project-as'
        : key === 's' ? 'save-project' : null;
  if (!command) return false;
  event.preventDefault();
  void dispatcher.dispatch(command);
  return true;
}

export default function App() {
  return <TooltipProvider><PaintingProvider><AppContent /></PaintingProvider></TooltipProvider>;
}

function AppContent() {
  const paintingPhase = usePaintingPhase();
  const mutationPending = useProjectStore(s => s.projectMutationPendingCount);
  const historyTransaction = useHistoryNavigationStore(s => s.status?.activeTransactionId);
  const filamentPending = useFilamentSessionStore(s => s.pendingKind);
  const historyRestoring = useHistoryRestoreStore(s => s.phase !== 'idle');
  const arranging = useArrangementStore(state => state.active);
  const platform = usePlatform();
  const setMetadata = useSettingsStore((s) => s.setMetadata);
  const hydrateProfileSnapshot = useSettingsStore((s) => s.hydrateProfileSnapshot);
  const applyNativeScopedConfigTransport = useSettingsStore((s) => s.applyNativeScopedConfigTransport);
  const setError = useSlicerStore((s) => s.setError);
  const modelLoaded = useSettingsStore((s) => s.modelLoaded);
  const status = useSlicerStore((s) => s.status);
  const progress = useSlicerStore((s) => s.progress);
  const slicerError = useSlicerStore((s) => s.error);
  const resultExported = useSlicerStore((s) => s.resultExported);
  // The high-level shell does not render the internal mutation-fence counter
  // or plate revision map. Selecting the entire store made every transform
  // lease acquisition/release synchronously rerender the full application.
  const projectState = useProjectStore(useShallow((s) => ({
    projectName: s.projectName,
    location: s.location,
    hasContent: s.hasContent,
    dirty: s.dirty,
    scope: s.scope,
    notices: s.notices,
    operation: s.operation,
  })));
  const [boot, setBoot] = useState<'starting' | 'ready' | 'failed'>('starting');
  const [workspaceEditing, setWorkspaceEditing] = useState(false);
  const [setup, setSetup] = useState<'mandatory' | 'menu' | null>(null);
  const setupRef = useRef(setup);
  setupRef.current = setup;
  useLayoutEffect(() => { useSetupWizardStore.getState().setActive(setup !== null); return () => useSetupWizardStore.getState().setActive(false); }, [setup]);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootProgress, setBootProgress] = useState('Loading preferences...');
  const [activeTab, setActiveTab] = useState<AppTab>('home');
  const [leftSidebarVisible, setLeftSidebarVisible] = useState(true);
  const [rightSidebarVisible, setRightSidebarVisible] = useState(true);
  const sidebarVisibilityRef = useRef({ left: true, right: true });
  const sidebarPreferenceSaveRef = useRef(Promise.resolve());
  const toggleSidebar = (side: 'left' | 'right') => {
    const visibility = { ...sidebarVisibilityRef.current, [side]: !sidebarVisibilityRef.current[side] };
    sidebarVisibilityRef.current = visibility;
    setLeftSidebarVisible(visibility.left);
    setRightSidebarVisible(visibility.right);
    // Serialize toggles so rapid left/right clicks cannot overwrite each other.
    sidebarPreferenceSaveRef.current = sidebarPreferenceSaveRef.current.then(async () => {
      await updateUserPreferences(platform.preferences, preferences => ({
        ...preferences,
        ui: { ...preferences.ui, leftSidebarCollapsed: !visibility.left, rightSidebarCollapsed: !visibility.right },
      }));
    }).catch(() => undefined);
  };
  // Navigation hides the workspace without changing its internal mode. Update
  // during render so children never commit an intermediate Prepare/Preview mode.
  const [workspaceTab, setWorkspaceTab] = useState<'prepare' | 'preview'>('prepare');
  if (isWorkspaceTab(activeTab) && workspaceTab !== activeTab) setWorkspaceTab(activeTab);
  const workspaceTabRef = useRef(workspaceTab);
  workspaceTabRef.current = workspaceTab;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const navigationRequest = useRef(0);
  const [prewarmingWorkspace, setPrewarmingWorkspace] = useState(false);
  const [dialog, setDialog] = useState<'load-choice' | 'dirty' | 'preferences' | 'notice' | 'project-confirm' | null>(null);
  const [loadInput, setLoadInput] = useState<ProjectInput | null>(null);
  const [dirtyOperation, setDirtyOperation] = useState<'new' | 'open' | 'close'>('open');
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [extraNotice, setExtraNotice] = useState<string | null>(null);
  const [projectConfirmation, setProjectConfirmation] = useState<ProjectLoadResult | null>(null);
  const [fileManagerOpen, setFileManagerOpen] = useState(false);
  const [fileManagerFocusRequest, setFileManagerFocusRequest] = useState(0);
  const loadChoiceResolver = useRef<((choice: ProjectLoadChoice) => void) | null>(null);
  const dirtyResolver = useRef<((decision: DirtyProjectDecision) => void) | null>(null);
  const projectConfirmationResolver = useRef<((confirmed: boolean) => void) | null>(null);
  // The receipt comes from the same action that has applied the native result,
  // reset history, and published the project session. Production UI does not
  // consume it; E2E uses it to prove its selected project reached a commit.
  const projectLoadReceiptRef = useRef<ProjectLoadReceipt | null>(null);
  const previewTransitionRef = useRef<PreviewRenderTransition | null>(null);
  const handleTabChange = useCallback((tab: AppTab) => {
    if (setupRef.current || !paintingCommandAllowed()) return;
    const request = ++navigationRequest.current;
    const navigate = () => {
      if (request !== navigationRequest.current) return;
      if (tab !== 'preview') {
        previewTransitionRef.current?.cancel();
        setPrewarmingWorkspace(false);
        setActiveTab(tab);
        return;
      }
      // A retained Preview has already rendered; only prewarm when switching
      // the hidden workspace from Prepare into Preview.
      if (!isWorkspaceTab(activeTabRef.current) && workspaceTabRef.current !== 'preview') {
        const transition = previewTransitionRef.current;
        if (transition) {
          setPrewarmingWorkspace(true);
          transition.begin();
          return;
        }
      }
      setActiveTab(tab);
    };
    if (tab === 'preview' && paintingSessionActive()) {
      void closePaintingForCommand().then((closed) => { if (closed) navigate(); });
    } else navigate();
  }, []);
  const navigateToPreview = useCallback(() => {
    handleTabChange('preview');
  }, [handleTabChange]);
  const handleModelAdded = useCallback(() => {
    // Model additions always land in Prepare, even when the user changed tabs
    // while the picker/drop operation was still in flight.
    setActiveTab('prepare');
  }, []);
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
  const historyRestoreCoordinatorRef = useRef<HistoryRestoreCoordinator | null>(null);
  const [historyRestoreCoordinator, setHistoryRestoreCoordinator] = useState<HistoryRestoreCoordinator | null>(null);
  const handleHistoryRestoreCoordinatorChange = useCallback((coordinator: HistoryRestoreCoordinator | null) => {
    historyRestoreCoordinatorRef.current = coordinator;
    setHistoryRestoreCoordinator(coordinator);
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
  const decideDirty = useCallback((operation: 'new' | 'open' | 'close') => new Promise<DirtyProjectDecision>((resolve) => {
    setDirtyOperation(operation); dirtyResolver.current = resolve; setDialog('dirty');
  }), []);
  const confirmProjectLoad = useCallback((load: ProjectLoadResult) => new Promise<boolean>((resolve) => {
    setProjectConfirmation(load);
    projectConfirmationResolver.current = resolve;
    setDialog('project-confirm');
  }), []);
  const reportProjectFailure = useCallback((result: { status: string; error?: unknown }) => {
    if (result.status === 'failed') {
      const message = result.error instanceof Error ? result.error.message : String(result.error ?? '');
      if (/g.?code|sliced.?result|embedded/i.test(message)) setExtraNotice('3MF files containing embedded G-code or a sliced-result package are unsupported. The current project was left unchanged.');
      else setError(message);
    }
  }, [setError]);
  const runNewProject = useCallback(async () => {
    const result = await newProject(platform, { decideDirty, sceneResetTarget: sceneInteractionRef.current });
    reportProjectFailure(result);
    if (result.status === 'ok') setActiveTab('prepare');
  }, [decideDirty, platform, reportProjectFailure]);
  const runOpenProject = useCallback(async () => {
    projectLoadReceiptRef.current = null;
    const result = await openProject(platform, { chooseLoad, decideDirty, confirmProjectLoad });
    if (result.status === 'ok' && result.loadReceipt) projectLoadReceiptRef.current = result.loadReceipt;
    reportProjectFailure(result);
    if (result.status === 'ok') { setActiveTab('prepare'); setDialog(null); }
  }, [chooseLoad, confirmProjectLoad, decideDirty, platform, reportProjectFailure]);
  const runCloseRequest = useCallback(async () => {
    // Startup has not admitted a user project yet. Querying the
    // Worker here can block the native close handshake while init/profile
    // restoration is still in progress, leaving the loading screen unable to
    // close. There is no dirty project to protect until boot is ready.
    if (boot !== 'ready') {
      await platform.lifecycle?.respondClose(true);
      return;
    }
    if (!paintingCommandAllowed()) { await platform.lifecycle?.respondClose(false); return; }
    let allow = true;
    if (await projectDirtyStatus(platform)) {
      const decision = await decideDirty('close');
      if (decision === 'cancel') allow = false;
      else if (decision === 'save') {
        const result = await saveProject(platform);
        reportProjectFailure(result);
        allow = result.status === 'ok';
      }
    }
    if (allow) allow = await closePaintingForCommand();
    await platform.lifecycle?.respondClose(allow);
  }, [boot, decideDirty, platform, reportProjectFailure]);
  const runSaveProject = useCallback(async (asCopy = false) => {
    const result = asCopy ? await saveProjectAs(platform) : await saveProject(platform);
    reportProjectFailure(result);
  }, [platform, reportProjectFailure]);
  const openPreferences = useCallback(async () => {
    try { setPreferences(await platform.preferences.load()); } catch { setPreferences(null); }
    setDialog('preferences');
  }, [platform.preferences]);
  const openFileManager = useCallback(async () => {
    setFileManagerOpen(true);
    setFileManagerFocusRequest((request) => request + 1);
  }, []);
  const savePreferences = useCallback(async (behaviour: ProjectLoadBehaviour) => {
    const next = await updateUserPreferences(platform.preferences, current => ({ ...current, projectLoadBehaviour: behaviour }));
    setPreferences(next);
  }, [platform.preferences, preferences]);

  const menuState = useMemo(() => buildMenuStateSnapshot({
    version: 1,
    activeTab,
    boot: { phase: setup ? 'setup' : boot, error: bootError },
    slicer: {
      status, progress, error: slicerError,
      threaded: platform.runtime.getRuntimeExecutionState?.().threaded ?? null,
    },
    scene: { hasModel: modelLoaded, arranging, editing: workspaceEditing || paintingPhase !== 'closed' || mutationPending > 0 || !!historyTransaction || !!filamentPending || historyRestoring || dialog !== null },
    result: { hasResult: status === 'done', exported: resultExported },
    project: {
      hasContent: projectState.hasContent,
      dirty: projectState.dirty,
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
    setup,
    activeTab,
    bootError,
    modelLoaded,
    platform.chrome,
    progress,
    resultExported,
    slicerError,
    status,
    projectState,
    workspaceEditing, arranging, paintingPhase, mutationPending, historyTransaction, filamentPending, historyRestoring, dialog,
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
      saveProject: () => runSaveProject(false),
      saveProjectAs: () => runSaveProject(true),
      preferences: openPreferences,
      setupWizard: async () => {
        if (paintingSessionActive() || sceneInteractionRef.current?.activeDrag || useProjectStore.getState().projectMutationPendingCount) return;
        setFileManagerOpen(false); setSetup('menu');
      },
      addModel: async () => { await addModel(platform, sceneInteractionRef.current, handleModelAdded); },
      clearScene: () => clearScene(platform, sceneInteractionRef.current),
      slice: requestPreviewSlice,
      exportGcode: () => exportGcode(platform),
      openSource: async () => { await platform.externalLinks.openSource(); },
      openConfigurationFolder: async () => { await platform.menu.execute('open-configuration-folder'); },
      openFileManager,
      quit: async () => { await platform.menu.execute('quit'); },
    },
  }), [handleModelAdded, openFileManager, openPreferences, platform, requestPreviewSlice, runNewProject, runOpenProject, runSaveProject]);

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
      handleMenuKeyDown(event, dispatcher);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [dispatcher]);
  useEffect(() => {
    const onHistoryKeyDown = (event: KeyboardEvent) => {
      // Project history is an editing operation. Preview/Device/Home retain
      // their own interaction semantics and must not consume this shortcut.
      if (setupRef.current || !isPrepareTab(activeTab) || isEditableHistoryTarget(event.target) || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      const action = historyShortcutAction(event);
      if (!action) return;
      const coordinator = historyRestoreCoordinatorRef.current;
      if (!coordinator) return;
      const historyStatus = useHistoryNavigationStore.getState().status;
      const restoring = useHistoryRestoreStore.getState().phase !== 'idle';
      if (isSerialSliceBusy(platform.runtime, useSlicerStore.getState().status)) return;
      if (!historyNavigationIntentAllowed(historyStatus, action, restoring)) return;
      event.preventDefault();
      void coordinator.restore(action);
    };
    document.addEventListener('keydown', onHistoryKeyDown);
    return () => document.removeEventListener('keydown', onHistoryKeyDown);
  }, [activeTab, platform.runtime]);
  useEffect(() => {
    if (projectState.notices.length > 0) setDialog('notice');
  }, [projectState.notices]);
  const titleBar = (
    <TitleBar
      chrome={platform.chrome}
      model={menuModel}
      state={menuState}
      activeTab={activeTab}
      onTabChange={handleTabChange}
      historyRestoreCoordinator={historyRestoreCoordinator}
      projectName={projectState.projectName}
      projectDirty={projectState.dirty}
      navigationDisabled={boot !== 'ready' || setup !== null}
      leftSidebarVisible={leftSidebarVisible}
      rightSidebarVisible={rightSidebarVisible}
      onToggleLeftSidebar={() => toggleSidebar('left')}
      onToggleRightSidebar={() => toggleSidebar('right')}
      onCommand={(command) => { void dispatcher.dispatch(command); }}
    />
  );

  // Explicit context-menu triggers and the 3D scene own their right-clicks;
  // editors retain native copy/paste menus. Empty space elsewhere suppresses
  // the browser/host default menu.
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
      // Scene and explicit UI context-menu triggers own their right-clicks.
      if (target.closest('canvas[data-engine^="three.js"], [data-slot="context-menu-trigger"]')) return;
      event.preventDefault();
    };
    document.addEventListener('contextmenu', suppressEmptySpaceContextMenu, true);
    return () => document.removeEventListener('contextmenu', suppressEmptySpaceContextMenu, true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const unsubscribeStartupProgress = platform.runtime.onStartupProgress?.((text) => {
      if (!cancelled) setBootProgress(text);
    });
    (async () => {
      try {
        setBoot('starting');
        setBootProgress('Loading preferences...');
        const preferences = await platform.preferences.load();
        if (cancelled) return;
        const sidebarVisibility = {
          left: preferences.ui.leftSidebarCollapsed !== true,
          right: preferences.ui.rightSidebarCollapsed !== true,
        };
        sidebarVisibilityRef.current = sidebarVisibility;
        setLeftSidebarVisible(sidebarVisibility.left);
        setRightSidebarVisible(sidebarVisibility.right);
        setBootProgress('Starting slicer runtime...');
        const init = await platform.runtime.init(preferences.profileActivation ?? null);
        if (!init.ok) throw new Error(init.error ?? 'orc_init failed');
        if (cancelled) return;
        setBootProgress('Loading slicer settings...');
        const metadata = await platform.runtime.getOptionMetadata();
        const nativeScopedConfig = await platform.runtime.getNativeScopedConfig();
        if (!nativeScopedConfig.ok || nativeScopedConfig.nativeScopedConfig.kind !== 'full')
          throw new Error(nativeScopedConfig.ok ? 'boot scoped configuration is not a full snapshot' : nativeScopedConfig.error);
        setMetadata(metadata);
        if (init.setupRequired) {
          // No saved selection/rack restoration before mandatory setup.
          if (applyNativeScopedConfigTransport(nativeScopedConfig.nativeScopedConfig) === 'stale')
            throw new Error('initial scoped configuration snapshot was stale');
          setSetup('mandatory');
          return;
        }
        setBootProgress('Restoring profile selections...');
        // Restore only names; compatibility and defaults remain authoritative
        // in the C++ preset bundle. The bridge response is written back so a
        // missing/corrupt selection is healed for the next boot.
        const restored = await restoreBootstrapSession(platform.runtime, preferences, {
          selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
          activePlateId: null,
          gizmo: null,
          nativeScopedConfig: nativeScopedConfig.nativeScopedConfig.snapshot as unknown as HistoryContext['nativeScopedConfig'],
        });
        if (cancelled) return;
        useFilamentSessionStore.setState({ snapshot: restored.filament, rejected: null });
        await persistRestoredSelections(platform.preferences, restored.preferences);
        if (cancelled) return;
        hydrateProfileSnapshot(restored.snapshot);
        const restoredConfig = await platform.runtime.getNativeScopedConfig();
        if (!restoredConfig.ok) throw new Error(restoredConfig.error);
        if (applyNativeScopedConfigTransport(restoredConfig.nativeScopedConfig) === 'stale')
          throw new Error('boot scoped configuration snapshot was stale');
        useProjectStore.getState().setProject({
          systemPresets: {
            printer: restored.snapshot.printer.name,
            print: restored.snapshot.print.name,
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
    return () => {
      cancelled = true;
      unsubscribeStartupProgress?.();
    };
  }, [applyNativeScopedConfigTransport, hydrateProfileSnapshot, setMetadata, setError, platform.preferences, platform.runtime]);

  useEffect(() => {
    if (platform.chrome.kind !== 'web') return;
    const protect = (event: BeforeUnloadEvent) => {
      // Browser lifecycle cannot present the app's Save/Don't Save/Cancel
      // dialog. It only gets the native leave/cancel prompt, and must never
      // trigger a download while the browser is unloading.
      if (!useProjectStore.getState().dirty && paintingCommandAllowed()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [platform.chrome.kind]);

  // Electron's close request enters the same shared dirty dialog/save path as
  // New and Open. The Web host intentionally has no lifecycle bridge here;
  // its beforeunload handler remains the browser-native leave/cancel prompt.
  useEffect(() => {
    if (platform.chrome.kind !== 'desktop' || !platform.lifecycle) return;
    return platform.lifecycle.onCloseRequest(() => { void runCloseRequest(); });
  }, [platform.chrome.kind, platform.lifecycle, runCloseRequest]);

  // A dropped 3MF is an Open Project entry point. Convert files at the host
  // boundary, then pass the complete batch into the shared action layer so
  // policy, choice, dirty protection, and compatibility handling are shared
  // with File > Open Project.
  const handleDroppedProjectFiles = useCallback(async (files: File[]) => {
    if (setupRef.current || boot !== 'ready') return;
    try {
      const dropped = platform.projects.openDropped
        ? await platform.projects.openDropped(files)
        : { status: 'ok' as const, inputs: await Promise.all(files.map(async (file) => ({
            displayName: file.name,
            bytes: new Uint8Array(await file.arrayBuffer()),
          }))) };
      if (dropped.status === 'cancelled') return;
      if (dropped.status === 'failed') { reportProjectFailure(dropped); return; }
       const result = await openProject(platform, { inputs: dropped.inputs, chooseLoad, decideDirty, confirmProjectLoad });
      reportProjectFailure(result);
      if (result.status === 'ok') { setActiveTab('prepare'); setDialog(null); }
    } catch (error) {
      reportProjectFailure({ status: 'failed', error });
    }
  }, [boot, chooseLoad, confirmProjectLoad, decideDirty, platform, reportProjectFailure]);
  const handleDroppedModelFiles = useCallback(async (files: File[]) => {
    if (setupRef.current || boot !== 'ready') return;
    try {
      await addDroppedModels(platform, sceneInteractionRef.current, () => Promise.all(files.map(async (file) => ({
        displayName: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      }))), files.length, handleModelAdded);
    } catch (error) {
      useSlicerStore.getState().setError(errorText(error));
      console.error('dropped model import failed:', error);
    }
  }, [boot, handleModelAdded, platform]);
  useEffect(() => {
    // Capture file drops before nested object-list handlers can stop
    // propagation for their own text-based reorder gestures.
    return registerProjectDropHandlers(document, {
      onProjectDrop: handleDroppedProjectFiles,
      onModelDrop: handleDroppedModelFiles,
    });
  }, [boot, handleDroppedModelFiles, handleDroppedProjectFiles]);

  const handleSetupApplied = useCallback(async (result: Extract<SetupCompletionResult, { ok: true }>) => {
    await publishSetupWizardApplication(platform, result, setupRef.current === 'mandatory' ? 'initial-setup' : 'existing-project');
  }, [platform]);
  const setupWizard = setup ? <SetupWizard platform={platform} mandatory={setup === 'mandatory'}
    onApplied={handleSetupApplied} onClose={() => { if (setup === 'mandatory') setBoot('ready'); setSetup(null); }} /> : null;
  useEffect(() => {
    if (!setup) return;
    const guard = (event: KeyboardEvent) => {
      const target = event.target;
      const inside = target instanceof Element && !!target.closest('[data-testid="setup-wizard"], [data-slot="select-content"]');
      if (!inside || ((event.ctrlKey || event.metaKey) && ['n', 'o', 's', 'z', 'y'].includes(event.key.toLowerCase()))) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    };
    document.addEventListener('keydown', guard, true);
    return () => document.removeEventListener('keydown', guard, true);
  }, [setup]);

  const appE2eProbe = __ORCA_E2E__
    ? <AppE2eProbe platform={platform} projectLoadReceiptRef={projectLoadReceiptRef} />
    : null;
  const fileManagerWindow = fileManagerOpen
    ? <FileManagerWindow focusRequest={fileManagerFocusRequest} onClose={() => setFileManagerOpen(false)} />
    : null;

  // Keep normal application and project actions inert until the worker has
  // initialized the core and installed every profile package. This is
  // host-neutral: Electron and Web share startup behavior; File Manager is the
  // explicit read-only diagnostic exception for inspecting a partial MEMFS.
  if (boot !== 'ready') {
    // The window is frameless on desktop, so the startup screen must carry
    // the title bar too — otherwise there is no drag region to move the
    // window while the runtime loads (see doc/2026-08-15-frameless-window.md).
    return (
      <>
        {appE2eProbe}
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
                <p className="text-sm text-muted-foreground" data-testid="startup-progress" role="status" aria-live="polite">{bootProgress}</p>
              )}
            </section>
          </main>
        </div>
        {fileManagerWindow}
        {setupWizard}
      </>
    );
  }

  const notices = extraNotice
    ? [{ kind: 'compatibility-fallback' as const, message: extraNotice }]
    : projectState.notices;
  return (
    <>
      {appE2eProbe}
      <ArrangementEditBoundary>
      <AppShell
        titleBar={titleBar}
        activeTab={activeTab}
        prewarmWorkspace={prewarmingWorkspace}
        home={<div data-testid="home-page" />}
        workspace={<Workspace leftSidebarVisible={leftSidebarVisible} rightSidebarVisible={rightSidebarVisible} actionControls={<SliceButton activeTab={workspaceTab} onNavigateToDevice={() => handleTabChange('device')} onSlice={requestPreviewSlice} />} activeTab={workspaceTab} onEditingSessionChange={setWorkspaceEditing} onSceneInteractionChange={handleSceneInteractionChange} onSliceCoordinatorChange={handleSliceCoordinatorChange} onHistoryRestoreCoordinatorChange={handleHistoryRestoreCoordinatorChange} onRequestPreview={navigateToPreview} onModelAdded={handleModelAdded} onPreviewTransitionChange={handlePreviewTransitionChange} onPreviewRenderReady={completePreviewTransition} />}
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
        open={dialog === 'project-confirm' && projectConfirmation !== null}
        notices={projectConfirmation ? (noticesFor(projectConfirmation).length
          ? noticesFor(projectConfirmation)
          : [{ kind: 'compatibility-fallback' as const, message: 'Review this project before replacing the current session.' }]) : []}
        title="Review project compatibility"
        testId="project-load-confirmation-dialog"
        onClose={() => { projectConfirmationResolver.current?.(false); projectConfirmationResolver.current = null; setProjectConfirmation(null); setDialog(null); }}
        onContinue={() => { projectConfirmationResolver.current?.(true); projectConfirmationResolver.current = null; setProjectConfirmation(null); setDialog(null); }}
      />
      <ProjectNoticeDialog
        open={dialog === 'notice' && notices.length > 0}
        notices={notices}
        onClose={() => { setDialog(null); setExtraNotice(null); }}
      />
      <ProjectProgressDialog
        operation={projectState.operation}
        onCancel={() => { void cancelProjectOperation(platform); }}
      />
      </ArrangementEditBoundary>
      {fileManagerWindow}
      <ArrangementStatus />
      {setupWizard}
    </>
  );
}
