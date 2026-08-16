// apps/desktop/src/renderer/src/components/toolbar/Toolbar.tsx
import { useState } from 'react';
import { FolderOpen, Slice, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { slicerClient } from '../../slicer/slicerClient';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { errorText } from '../../slicer/errors';

export function Toolbar() {
  const status = useSlicerStore((s) => s.status);
  const setSlicerStatus = useSlicerStore((s) => s.setStatus);
  const setError = useSlicerStore((s) => s.setError);
  const modelLoaded = useSettingsStore((s) => s.modelLoaded);
  const busy = status === 'slicing';
  const [exporting, setExporting] = useState(false);

  async function openModel() {
    // Any load attempt (success, failure, or dialog cancel) invalidates the
    // slice result — reset status so Export is gated until the new model is
    // re-sliced (stale-export fix, review finding 1).
    setSlicerStatus('idle');
    useSettingsStore.getState().setModelLoaded(false);
    useSettingsStore.getState().setSelectedObject(null);
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
      useSettingsStore.getState().setModelLoaded(true);
      setError(null);
    } catch (err) {
      // errorText unwraps "Error: <msg>" (String(err)); the status bar
      // already prefixes "Error" (StatusBar statusText).
      setError(errorText(err));
      console.error('load model failed:', err);
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
    // A new slice clears the previous failure — the status bar must not keep
    // showing the old error while the new slice runs (or if it succeeds).
    setError(null);
    try {
      const r = await slicerClient.slice(values, (pct) => useSlicerStore.getState().setProgress(pct));
      // A failed slice is not a thrown error: r.error is the bridge's plain
      // message (set it directly — a `new Error(...)` + String(err) round
      // trip would double-wrap it as "Error: <msg>"; the status bar already
      // prefixes "Error").
      if (!r.ok) {
        setSlicerStatus('error');
        setError(r.error ?? 'slice failed');
        console.error('slice failed:', r.error);
        return;
      }
      if (r.unrecognized_keys.length) {
        console.warn('unrecognized keys dropped by libslic3r:', r.unrecognized_keys);
      }
      setSlicerStatus('done');
    } catch (err) {
      setSlicerStatus('error');
      setError(errorText(err));
      console.error('slice failed:', err);
    }
  }

  async function exportGcode() {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await slicerClient.exportGcode();
      if (!res.ok) throw new Error(res.error ?? 'export failed');
      const { path } = await window.orca.saveFileDialog('output.gcode', [
        { name: 'G-code', extensions: ['gcode'] },
      ]);
      if (!path) return; // canceled — nothing to do
      await window.orca.writeFile(path, res.bytes.buffer.slice(
        res.bytes.byteOffset,
        res.bytes.byteOffset + res.bytes.byteLength,
      ) as ArrayBuffer);
    } catch (err) {
      setError(`export: ${errorText(err)}`);
      console.error('export failed:', err);
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="secondary" onClick={openModel} data-testid="btn-open">
        <FolderOpen className="h-4 w-4" /> Open
      </Button>
      <Button size="sm" variant="secondary" onClick={slice} disabled={busy || !modelLoaded} data-testid="btn-slice">
        <Slice className="h-4 w-4" /> {busy ? 'Slicing…' : 'Slice'}
      </Button>
      <Button size="sm" variant="default" disabled={busy || exporting || !modelLoaded || status !== 'done'} onClick={exportGcode} title="Export G-code" data-testid="btn-export">
        <Download className="h-4 w-4" /> {exporting ? 'Exporting…' : 'Export'}
      </Button>
    </>
  );
}
