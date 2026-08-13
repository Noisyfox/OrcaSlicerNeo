// apps/desktop/src/renderer/src/components/toolbar/Toolbar.tsx
import { FolderOpen, Slice, Download } from 'lucide-react';
import { Button } from '../ui/button';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { slicerClient } from '../../slicer/slicerClient';
import { useSettingsStore } from '../../stores/useSettingsStore';

export function Toolbar() {
  const status = useSlicerStore((s) => s.status);
  const setSlicerStatus = useSlicerStore((s) => s.setStatus);
  const setError = useSlicerStore((s) => s.setError);
  const busy = status === 'slicing';

  async function openModel() {
    const { path } = await window.orca.openFileDialog([
      { name: 'Models', extensions: ['stl', '3mf'] },
      { name: 'All files', extensions: ['*'] },
    ]);
    if (!path) return;
    try {
      const buf = await window.orca.readFile(path);
      const ext = path.split('.').pop() ?? 'stl';
      const r = await slicerClient.loadModel(new Uint8Array(buf), ext);
      if (!r.ok) throw new Error(r.error ?? 'load failed');
      useSettingsStore.getState().setValue('modelPath', path);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }

  async function slice() {
    if (busy) return;
    // Only send keys the metadata declares — UI-only keys (printer, print,
    // filament, modelPath) are not print options and would land in the
    // bridge's unrecognized_keys warning.
    const state = useSettingsStore.getState();
    const meta = state.metadata ?? {};
    const values = Object.fromEntries(
      Object.entries(state.values).filter(([k]) => meta[k] !== undefined),
    );
    setSlicerStatus('slicing');
    try {
      const r = await slicerClient.slice(values, (pct) => useSlicerStore.getState().setProgress(pct));
      if (!r.ok) throw new Error(r.error ?? 'slice failed');
      if (r.unrecognized_keys.length) {
        console.warn('unrecognized keys dropped by libslic3r:', r.unrecognized_keys);
      }
      setSlicerStatus('done');
    } catch (err) {
      setSlicerStatus('error');
      setError(String(err));
    }
  }

  return (
    <>
      <Button size="sm" variant="secondary" onClick={openModel}>
        <FolderOpen className="h-4 w-4" /> Open
      </Button>
      <Button size="sm" variant="secondary" onClick={slice} disabled={busy}>
        <Slice className="h-4 w-4" /> {busy ? 'Slicing…' : 'Slice'}
      </Button>
      <Button size="sm" variant="default" disabled={busy} title="Export G-code">
        <Download className="h-4 w-4" /> Export
      </Button>
    </>
  );
}
