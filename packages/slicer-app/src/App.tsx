// apps/desktop/src/renderer/src/App.tsx (boot effect: app config load →
// worker client init → presets ×3 → option metadata → settings store)
import { useEffect, useState } from 'react';
import { AppShell } from './components/layout/AppShell';
import { Toolbar } from './components/toolbar/Toolbar';
import { SettingsPanel } from './components/settings/SettingsPanel';
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
  const [sceneInteraction, setSceneInteraction] = useState<SceneInteractionController | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
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
