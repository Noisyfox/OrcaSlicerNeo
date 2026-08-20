// apps/desktop/src/renderer/src/components/toolbar/Toolbar.tsx
import { useState } from 'react';
import { FolderPlus, Slice, Download, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { errorText } from '@orca/slicer-runtime';
import { glVolumeCollection } from '../viewport/GLVolume';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { syncModelTransforms } from './syncModelTransforms';
import { waitForSettledModelTransforms } from './persistModelTransforms';
import { usePlatform } from '@orca/platform-contract';

export function Toolbar({ sceneInteraction }: { sceneInteraction: SceneInteractionController | null }) {
  const platform = usePlatform();
  const status = useSlicerStore((s) => s.status);
  const setSlicerStatus = useSlicerStore((s) => s.setStatus);
  const setError = useSlicerStore((s) => s.setError);
  const modelLoaded = useSettingsStore((s) => s.modelLoaded);
  // Boot loads all three preset lists atomically (setPresets); until they
  // arrive (or if boot fails) Add Model stays disabled — a model without presets
  // can't be configured or sliced.
  const presetsLoaded = useSettingsStore(
    (s) => s.printers.length > 0 && s.prints.length > 0 && s.filaments.length > 0,
  );
  const busy = status === 'slicing';
  const [exporting, setExporting] = useState(false);

  async function addModel() {
    const file = await platform.models.pick();
    if (!file) return;
    try {
      const ext = file.displayName.split('.').pop() ?? 'stl';
      // A just-finished gesture persists its settled state on release. Wait
      // for that commit before the additive import refreshes the collection.
      const synced = await waitForSettledModelTransforms();
      if (!synced.ok) throw new Error(synced.error ?? 'model synchronization failed');
      const r = await platform.runtime.addModel(file.bytes, ext);
      if (!r.ok) throw new Error(r.error ?? 'add failed');
      // Only a successful add changes the plate. A dialog cancel or parse
      // failure must leave the existing scene and its sliced result intact.
      setSlicerStatus('idle');
      // Shared state receives only the display name; host-private absolute
      // paths must never cross the platform boundary.
      useSettingsStore.getState().setValue('modelPath', file.displayName);
      useSettingsStore.getState().setModelLoaded(true);
      sceneInteraction?.resetForModel();
      setError(null);
    } catch (err) {
      // errorText unwraps "Error: <msg>" (String(err)); the status bar
      // already prefixes "Error" (StatusBar statusText).
      setError(errorText(err));
      console.error('add model failed:', err);
    }
  }

  async function clearScene() {
    if (busy || !modelLoaded) return;
    try {
      const r = await platform.runtime.clearModel();
      if (!r.ok) throw new Error(r.error ?? 'clear scene failed');
      setSlicerStatus('idle');
      useSettingsStore.getState().setModelLoaded(false);
      sceneInteraction?.resetForModel();
      setError(null);
    } catch (err) {
      setError(errorText(err));
      console.error('clear scene failed:', err);
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
    // layer_height is present in the real profile metadata, but older profile
    // bundles may omit its bounds. It is never valid at zero and libslic3r's
    // downstream layer math aborts before the bridge can serialize an error.
    const rawLayerHeight = state.values.layer_height;
    if (rawLayerHeight !== undefined && Number.parseFloat(rawLayerHeight) <= 0) {
      setSlicerStatus('error');
      setError('layer_height must be greater than 0');
      return;
    }
    // Reject impossible numeric values before entering libslic3r. Some
    // low-level config paths (notably layer_height=0) abort the native/WASM
    // runtime instead of returning a bridge error. Metadata is authoritative
    // and already carries the same min/max constraints used by the controls.
    for (const [key, value] of Object.entries(values)) {
      const option = meta[key];
      if (!option || !['float', 'int', 'percent', 'float_or_percent'].includes(option.type)) continue;
      const numeric = Number.parseFloat(value.replace('%', ''));
      if (!Number.isFinite(numeric)) {
        setSlicerStatus('error');
        setError(`${key} must be a number`);
        return;
      }
      if (option.min !== undefined && numeric < option.min || option.max !== undefined && numeric > option.max) {
        const bounds = [option.min, option.max].filter((bound) => bound !== undefined).join('–');
        setSlicerStatus('error');
        setError(`${key} must be between ${bounds}`);
        return;
      }
    }
    // Apply all renderer-side CompositeIDs to the C++ Model at the slice
    // boundary. Interaction never waits on the worker.
    const synced = await syncModelTransforms(platform.runtime, glVolumeCollection.volumes);
    if (!synced.ok) {
      setSlicerStatus('error');
      setError(synced.error ?? 'model synchronization failed');
      return;
    }
    setSlicerStatus('slicing');
    // A new slice clears the previous failure — the status bar must not keep
    // showing the old error while the new slice runs (or if it succeeds).
    setError(null);
    try {
      const r = await platform.runtime.slice(values, (pct) => useSlicerStore.getState().setProgress(pct));
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
      const res = await platform.runtime.exportGcode();
      if (!res.ok) throw new Error(res.error ?? 'export failed');
      await platform.exports.save('output.gcode', res.bytes);
    } catch (err) {
      setError(`export: ${errorText(err)}`);
      console.error('export failed:', err);
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="secondary" onClick={addModel} disabled={!presetsLoaded} data-testid="btn-add-model">
        <FolderPlus className="h-4 w-4" /> Add Model
      </Button>
      <Button size="sm" variant="secondary" onClick={clearScene} disabled={busy || !modelLoaded} data-testid="btn-clear-scene">
        <Trash2 className="h-4 w-4" /> Clear Scene
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
