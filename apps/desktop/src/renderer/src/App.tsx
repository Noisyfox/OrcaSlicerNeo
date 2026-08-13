// apps/desktop/src/renderer/src/App.tsx (boot effect: worker client init →
// presets ×3 → option metadata → settings store)
import { useEffect } from 'react';
import { AppShell } from './components/layout/AppShell';
import { Toolbar } from './components/toolbar/Toolbar';
import { SettingsPanel } from './components/settings/SettingsPanel';
import { Viewport } from './components/viewport/Viewport';
import { StatusBar } from './components/status/StatusBar';
import { slicerClient } from './slicer/slicerClient';
import { useSettingsStore } from './stores/useSettingsStore';
import { useSlicerStore } from './stores/useSlicerStore';

export default function App() {
  const setMetadata = useSettingsStore((s) => s.setMetadata);
  const setPresets = useSettingsStore((s) => s.setPresets);
  const setError = useSlicerStore((s) => s.setError);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const init = await slicerClient.init();
        if (!init.ok) throw new Error(init.error ?? 'orc_init failed');
        const [printers, prints, filaments] = await Promise.all([
          slicerClient.getPresets('printer'),
          slicerClient.getPresets('print'),
          slicerClient.getPresets('filament'),
        ]);
        const metadata = await slicerClient.getOptionMetadata();
        if (cancelled) return;
        setPresets(
          printers.presets.map((p) => p.name),
          prints.presets.map((p) => p.name),
          filaments.presets.map((p) => p.name),
        );
        setMetadata(metadata);
      } catch (err) {
        if (!cancelled) setError(`boot: ${String(err)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [setMetadata, setPresets, setError]);

  return (
    <AppShell
      toolbar={<Toolbar />}
      settings={<SettingsPanel />}
      viewport={<Viewport />}
      status={<StatusBar />}
    />
  );
}
