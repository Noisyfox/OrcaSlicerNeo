import type { PlatformCapabilities } from '@orca/platform-contract';
import { errorText } from '@orca/slicer-runtime';
import type { PlateOperationTarget } from '@slicer/client';
import { glVolumeCollection } from '../viewport/GLVolume';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { syncModelTransforms } from './syncModelTransforms';
import { applyPlateResultMutation } from '../../../stores/plateResultLifecycle';
import { waitForConfigurationMutations } from '../settings/configurationActions';

/**
 * Run the shared slice flow. Toolbar buttons and menu commands must use this
 * function so validation, transform persistence, and result state cannot drift.
 */
export async function sliceModel(platform: PlatformCapabilities): Promise<void> {
  if (useSlicerStore.getState().status === 'slicing') return;

  // Numeric/text fields commit on blur. A Slice click can arrive in the same
  // event turn, so wait for that Worker transaction before reading settings
  // or starting native slicing.
  await waitForConfigurationMutations();

  // Only send keys the metadata declares — UI-only keys (printer, print,
  // filament, modelPath) are not print options and would land in the
  // bridge's unrecognized_keys warning.
  const state = useSettingsStore.getState();
  const meta = state.metadata ?? {};
  const values = Object.fromEntries(
    Object.entries(state.values).filter(([key]) => meta[key] !== undefined),
  );
  const setFailure = (message: string) => {
    useSlicerStore.getState().setActiveSliceTarget(null);
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
  if (synced.plateSession) {
    applyPlateResultMutation(synced.plateSession);
    usePlateSessionStore.getState().setSnapshot(synced.plateSession);
  }

  const session = await platform.runtime.getPlateSessionSnapshot();
  if (!session.ok) { setFailure(session.error); return; }
  usePlateSessionStore.getState().setSnapshot(session);
  const current = session.plates.find((plate) => plate.plateId === session.currentPlateId);
  const revision = session.inputRevisions?.[session.currentPlateId];
  const membershipKnown = current?.instanceIds !== undefined || session.instances !== undefined;
  if (!current || current.valid === false || (membershipKnown && !(current.instanceIds?.length)) ||
      !Number.isSafeInteger(revision)) {
    setFailure(current?.valid === false ? 'current plate contains an out-of-bounds instance' : 'current plate is empty');
    return;
  }
  const target: PlateOperationTarget = { plateId: session.currentPlateId, inputRevision: revision as number };

  const existing = useSlicerStore.getState().plateResults[target.plateId];
  if (existing?.target.inputRevision === target.inputRevision) {
    useSlicerStore.getState().activatePlateResult(target.plateId, target.inputRevision);
    return;
  }

  const slicer = useSlicerStore.getState();
  slicer.setStatus('slicing');
  slicer.setActiveSliceTarget(target);
  slicer.setResultExported(false);
  slicer.setError(null);
  try {
    const result = await platform.runtime.slicePlate(
      target,
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
    // Read and retain the completed result while the worker still owns the
    // corresponding native Print. The immutable target guards against a
    // mutation/cancellation race; a late completion never becomes visible.
    const live = useSlicerStore.getState();
    if (!live.activeSliceTarget || live.activeSliceTarget.plateId !== target.plateId ||
        live.activeSliceTarget.inputRevision !== target.inputRevision) return;
    const preview = await platform.runtime.getSliceResult();
    if (!preview.ok) { setFailure(preview.error ?? 'slice result unavailable'); return; }
    const exported = await platform.runtime.exportGcodePlate(target);
    if (!exported.ok) { setFailure(exported.error ?? 'slice G-code unavailable'); return; }
    // A configuration or plate-local edit may have superseded the native
    // result while preview extraction/export were in flight.  Re-read the
    // authoritative plate revision immediately before publication so a late
    // result can never repopulate the renderer cache after invalidation.
    const finalSession = await platform.runtime.getPlateSessionSnapshot();
    const finalRevision = finalSession.ok ? finalSession.inputRevisions?.[target.plateId] : undefined;
    const finalLive = useSlicerStore.getState();
    if (!finalSession.ok || finalRevision !== target.inputRevision ||
        !finalLive.activeSliceTarget || finalLive.activeSliceTarget.plateId !== target.plateId ||
        finalLive.activeSliceTarget.inputRevision !== target.inputRevision) {
      if (finalLive.activeSliceTarget?.plateId === target.plateId &&
          finalLive.activeSliceTarget.inputRevision === target.inputRevision) {
        finalLive.setActiveSliceTarget(null);
        if (finalLive.status === 'slicing') finalLive.setStatus('idle');
      }
      return;
    }
    useSlicerStore.getState().setPlateResult(target, preview, exported.bytes);
    useSlicerStore.getState().setActiveSliceTarget(null);
    const current = usePlateSessionStore.getState().snapshot?.currentPlateId;
    if (current === target.plateId) useSlicerStore.getState().activatePlateResult(target.plateId, target.inputRevision);
  } catch (err) {
    useSlicerStore.getState().setActiveSliceTarget(null);
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
    const session = await platform.runtime.getPlateSessionSnapshot();
    if (!session.ok) throw new Error(session.error);
    const currentTarget = useSlicerStore.getState().sliceTarget;
    const revision = session.inputRevisions?.[session.currentPlateId];
    const target: PlateOperationTarget = { plateId: session.currentPlateId, inputRevision: Number(revision) };
    if (!currentTarget || currentTarget.plateId !== target.plateId || currentTarget.inputRevision !== target.inputRevision)
      throw new Error('current plate slice result is stale or unavailable');
    const cached = useSlicerStore.getState().plateResults[target.plateId];
    let bytes = cached?.target.inputRevision === target.inputRevision && cached.gcode ? cached.gcode : undefined;
    if (!bytes) {
      const fresh = await platform.runtime.exportGcodePlate(target);
      if (!fresh.ok) throw new Error(fresh.error ?? 'export failed');
      bytes = fresh.bytes;
    }
    if (!bytes) throw new Error('export failed');
    await platform.exports.save('output.gcode', bytes);
    useSlicerStore.getState().setResultExported(true);
  } catch (err) {
    useSlicerStore.getState().setError(`export: ${errorText(err)}`);
    console.error('export failed:', err);
  } finally {
    exportInFlight = false;
  }
}
