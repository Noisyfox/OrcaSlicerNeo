// packages/slicer-app/src/App.tsx (boot effect: app config load →
// worker client init → presets ×3 → option metadata → settings store)
import { useEffect, useState } from 'react';
import { AppShell } from './components/layout/AppShell';
import { TitleBar } from './components/layout/TitleBar';
import { Toolbar } from './components/toolbar/Toolbar';
import { SettingsPanel } from './components/settings/SettingsPanel';
import { ObjectList } from './components/objectList/ObjectList';
import { Viewport } from './components/viewport/Viewport';
import { StatusBar } from './components/status/StatusBar';
import { useSettingsStore } from './stores/useSettingsStore';
import { useSlicerStore } from './stores/useSlicerStore';
import type { SceneInteractionController } from './components/viewport/SceneInteractionController';
import { usePlatform } from '@orca/platform-contract';
import { restoreSelections } from './preferences';

export default function App() {
  const platform = usePlatform();
  const setMetadata = useSettingsStore((s) => s.setMetadata);
  const setPresets = useSettingsStore((s) => s.setPresets);
  const setError = useSlicerStore((s) => s.setError);
  const modelLoaded = useSettingsStore((s) => s.modelLoaded);
  const values = useSettingsStore((s) => s.values);
  const status = useSlicerStore((s) => s.status);
  const resultExported = useSlicerStore((s) => s.resultExported);
  const [sceneInteraction, setSceneInteraction] = useState<SceneInteractionController | null>(null);
  const [boot, setBoot] = useState<'starting' | 'ready' | 'failed'>('starting');
  const [bootError, setBootError] = useState<string | null>(null);

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
        const resolved = await restoreSelections(platform.runtime, preferences);
        const restored = await Promise.all([
          platform.runtime.getPresets('printer'),
          platform.runtime.getPresets('print'),
          platform.runtime.getPresets('filament'),
        ]);
        if (!cancelled) await platform.preferences.save(resolved);
        if (cancelled) return;
        // Entries carry the real is_visible/selected flags — the store
        // derives the picker's value + installed grouping from them.
        setPresets(restored[0].presets, restored[1].presets, restored[2].presets);
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
  }, [setMetadata, setPresets, setError]);

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
        <TitleBar chrome={platform.chrome} />
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
      toolbar={<Toolbar />}
      settings={<>
        <ObjectList sceneInteraction={sceneInteraction} />
        <SettingsPanel sceneInteraction={sceneInteraction} />
      </>}
      viewport={<Viewport onSceneInteractionChange={setSceneInteraction} sceneInteraction={sceneInteraction} />}
      status={<StatusBar />}
    />
  );
}
