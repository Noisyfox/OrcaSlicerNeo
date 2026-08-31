// packages/slicer-app/src/App.tsx (boot effect: app config load → worker
// client init → atomic preset snapshot → option metadata → settings store)
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from './components/layout/AppShell';
import { TitleBar } from './components/layout/TitleBar';
import { Toolbar } from './components/layout/Toolbar';
import type { AppTab } from './components/layout/appTabs';
import { Workspace } from './components/workspace/Workspace';
import { DevicePanel } from './components/device/DevicePanel';
import { StatusBar } from './components/layout/StatusBar';
import { useSettingsStore } from './stores/useSettingsStore';
import { useSlicerStore } from './stores/useSlicerStore';
import type { SceneInteractionController } from './components/workspace/viewport/SceneInteractionController';
import { usePlatform } from '@orca/platform-contract';
import { persistRestoredSelections, restoreSelections } from './preferences';
import { addModel, clearScene } from './components/workspace/actions/sceneActions';
import { exportGcode, sliceModel } from './components/workspace/actions/sliceActions';
import { createCommandDispatcher, registerNativeMenuCommands } from './menu/commands';
import { buildMenuModel, buildMenuStateSnapshot, resolveMenuMode } from './menu/menuModel';

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
  const [boot, setBoot] = useState<'starting' | 'ready' | 'failed'>('starting');
  const [bootError, setBootError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>('home');
  const handleTabChange = useCallback((tab: AppTab) => {
    setActiveTab(tab);
  }, []);
  // Workspace owns the controller; the dispatcher only ever reads it lazily at
  // dispatch time, so mirroring it into a ref keeps App out of the re-render.
  const sceneInteractionRef = useRef<SceneInteractionController | null>(null);
  const handleSceneInteractionChange = useCallback((controller: SceneInteractionController | null) => {
    sceneInteractionRef.current = controller;
  }, []);

  const menuState = useMemo(() => buildMenuStateSnapshot({
    version: 1,
    boot: { phase: boot, error: bootError },
    slicer: { status, progress, error: slicerError },
    scene: { hasModel: modelLoaded },
    result: { hasResult: status === 'done', exported: resultExported },
    host: {
      isElectron: platform.chrome.kind === 'desktop',
      menuMode: resolveMenuMode(platform.chrome),
    },
  }, platform.chrome), [
    boot,
    bootError,
    modelLoaded,
    platform.chrome,
    progress,
    resultExported,
    slicerError,
    status,
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
      addModel: () => addModel(platform, sceneInteractionRef.current),
      clearScene: () => clearScene(platform, sceneInteractionRef.current),
      slice: () => sliceModel(platform),
      exportGcode: () => exportGcode(platform),
      openSource: async () => { await platform.externalLinks.openSource(); },
      quit: async () => { await platform.menu.execute('quit'); },
    },
  }), [platform]);

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

  return (
    <AppShell
      titleBar={titleBar}
      toolbar={<Toolbar activeTab={activeTab} onTabChange={handleTabChange} onNavigateToDevice={() => setActiveTab('device')} />}
      activeTab={activeTab}
      home={<div data-testid="home-page" />}
      workspace={<Workspace activeTab={activeTab} onSceneInteractionChange={handleSceneInteractionChange} />}
      device={<DevicePanel />}
      status={<StatusBar />}
    />
  );
}
