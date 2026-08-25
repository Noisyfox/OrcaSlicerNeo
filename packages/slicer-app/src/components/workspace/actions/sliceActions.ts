import type { PlatformCapabilities } from '@orca/platform-contract';
import { errorText } from '@orca/slicer-runtime';
import { glVolumeCollection } from '../viewport/GLVolume';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { syncModelTransforms } from './syncModelTransforms';

/**
 * Run the shared slice flow. Toolbar buttons and menu commands must use this
 * function so validation, transform persistence, and result state cannot drift.
 */
export async function sliceModel(platform: PlatformCapabilities): Promise<void> {
  if (useSlicerStore.getState().status === 'slicing') return;

  // Only send keys the metadata declares — UI-only keys (printer, print,
  // filament, modelPath) are not print options and would land in the
  // bridge's unrecognized_keys warning.
  const state = useSettingsStore.getState();
  const meta = state.metadata ?? {};
  const values = Object.fromEntries(
    Object.entries(state.values).filter(([key]) => meta[key] !== undefined),
  );
  const setFailure = (message: string) => {
    useSlicerStore.getState().setStatus('error');
    useSlicerStore.getState().setError(message);
  };

  // Older profile bundles may omit layer_height bounds. It is never valid at
  // zero and libslic3r's downstream layer math aborts before the bridge can
  // serialize an error.
  const rawLayerHeight = state.values.layer_height;
  if (rawLayerHeight !== undefined && Number.parseFloat(rawLayerHeight) <= 0) {
    setFailure('layer_height must be greater than 0');
    return;
  }

  // Reject impossible numeric values before entering libslic3r. Metadata is
  // authoritative and already carries the same min/max constraints as the UI.
  for (const [key, value] of Object.entries(values)) {
    const option = meta[key];
    if (!option || !['float', 'int', 'percent', 'float_or_percent'].includes(option.type)) continue;
    const numeric = Number.parseFloat(value.replace('%', ''));
    if (!Number.isFinite(numeric)) {
      setFailure(`${key} must be a number`);
      return;
    }
    if ((option.min !== undefined && numeric < option.min) || (option.max !== undefined && numeric > option.max)) {
      const bounds = [option.min, option.max].filter((bound) => bound !== undefined).join('–');
      setFailure(`${key} must be between ${bounds}`);
      return;
    }
  }

  // Apply renderer-side CompositeIDs to the C++ Model at the slice boundary.
  const synced = await syncModelTransforms(platform.runtime, glVolumeCollection.volumes);
  if (!synced.ok) {
    setFailure(synced.error ?? 'model synchronization failed');
    return;
  }

  const slicer = useSlicerStore.getState();
  slicer.setStatus('slicing');
  slicer.setResultExported(false);
  slicer.setError(null);
  try {
    const result = await platform.runtime.slice(
      values,
      (pct) => useSlicerStore.getState().setProgress(pct),
    );
    if (!result.ok) {
      setFailure(result.error ?? 'slice failed');
      console.error('slice failed:', result.error);
      return;
    }
    if (result.unrecognized_keys.length) {
      console.warn('unrecognized keys dropped by libslic3r:', result.unrecognized_keys);
    }
    useSlicerStore.getState().setStatus('done');
  } catch (err) {
    setFailure(errorText(err));
    console.error('slice failed:', err);
  }
}

let exportInFlight = false;

/** Export the current slice through the injected host save operation. */
export async function exportGcode(platform: PlatformCapabilities): Promise<void> {
  if (exportInFlight) return;
  exportInFlight = true;
  try {
    const result = await platform.runtime.exportGcode();
    if (!result.ok) throw new Error(result.error ?? 'export failed');
    await platform.exports.save('output.gcode', result.bytes);
    useSlicerStore.getState().setResultExported(true);
  } catch (err) {
    useSlicerStore.getState().setError(`export: ${errorText(err)}`);
    console.error('export failed:', err);
  } finally {
    exportInFlight = false;
  }
}
