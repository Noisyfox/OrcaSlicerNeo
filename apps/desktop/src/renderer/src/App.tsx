// apps/desktop/src/renderer/src/App.tsx (boot effect: app config load →
// worker client init → presets ×3 → option metadata → settings store)
import { useEffect, useState } from 'react';
import type { AppConfig } from '@slicer/client';
import { AppShell } from './components/layout/AppShell';
import { Toolbar } from './components/toolbar/Toolbar';
import { SettingsPanel } from './components/settings/SettingsPanel';
import { Viewport } from './components/viewport/Viewport';
import { StatusBar } from './components/status/StatusBar';
import { slicerClient } from './slicer/slicerClient';
import { useSettingsStore } from './stores/useSettingsStore';
import { useSlicerStore } from './stores/useSlicerStore';
import type { SceneInteractionController } from './components/viewport/SceneInteractionController';

export default function App() {
  const setMetadata = useSettingsStore((s) => s.setMetadata);
  const setPresets = useSettingsStore((s) => s.setPresets);
  const setError = useSlicerStore((s) => s.setError);
  const [sceneInteraction, setSceneInteraction] = useState<SceneInteractionController | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // M4: the persisted app config (installed printers + selections) is
        // the bridge's single source of truth. No config file ⇒ fresh
        // config (bridge installs everything, picks the first non-default).
        const appConfig = await window.orca.appConfig.load();
        const init = await slicerClient.init(
          appConfig.found ? (appConfig.json as AppConfig) : undefined,
        );
        if (!init.ok) throw new Error(init.error ?? 'orc_init failed');
        const [printers, prints, filaments] = await Promise.all([
          slicerClient.getPresets('printer'),
          slicerClient.getPresets('print'),
          slicerClient.getPresets('filament'),
        ]);
        const metadata = await slicerClient.getOptionMetadata();
        if (cancelled) return;
        // Entries carry the real is_visible/selected flags — the store
        // derives the picker's value + installed grouping from them.
        setPresets(printers.presets, prints.presets, filaments.presets);
        setMetadata(metadata);
      } catch (err) {
        if (!cancelled) setError(`boot: ${String(err)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [setMetadata, setPresets, setError]);

  return (
    <AppShell
      toolbar={<Toolbar sceneInteraction={sceneInteraction} />}
      settings={<SettingsPanel sceneInteraction={sceneInteraction} />}
      viewport={<Viewport onSceneInteractionChange={setSceneInteraction} />}
      status={<StatusBar />}
    />
  );
}
