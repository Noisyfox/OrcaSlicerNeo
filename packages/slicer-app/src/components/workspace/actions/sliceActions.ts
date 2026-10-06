import { paintingCommandAllowed, closePaintingForCommand, paintingSessionActive } from '../viewport/gizmo/painting/projectCommands';
import { runProjectMutationOperation } from './historyMutation';
import type { PlatformCapabilities } from '@orca/platform-contract';
import { errorText } from '@orca/slicer-runtime';
import type { PlateOperationTarget } from '@slicer/client';
import { glVolumeCollection } from '../viewport/GLVolume';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { projectFilenameBase, useProjectStore } from '@/stores/useProjectStore';
import { syncModelTransforms } from './syncModelTransforms';
import { applyPlateResultMutation } from '@/stores/plateResultLifecycle';
import { waitForConfigurationMutations } from '../settings/configurationActions';

// Scene commands own these coordinates; cached Settings values must never
// override the current native position when composing a slice request.
const SLICE_CONFIG_BLACKLIST: ReadonlySet<string> = new Set([
  'wipe_tower_x',
  'wipe_tower_y',
]);

let activeCancellation: { requested: boolean } | null = null;
let sliceAdmission = false;

/** Request cancellation while retaining the active job until its terminal reply. */
export async function cancelSlice(platform: PlatformCapabilities): Promise<boolean> {
  const cancellation = activeCancellation;
  if (!cancellation || cancellation.requested) return false;
  cancellation.requested = true;
  try {
    const result = await platform.runtime.cancel();
    if (!result.ok) throw new Error(result.error ?? 'Slice cancellation failed');
    return true;
  } catch (error) {
    cancellation.requested = false;
    if (activeCancellation === cancellation) useSlicerStore.getState().setError(errorText(error));
    return false;
  }
}

/**
 * Run the shared slice flow. SliceButton and menu commands must use this
 * function so validation, transform persistence, and result state cannot drift.
 */
export async function sliceModel(platform: PlatformCapabilities, plateId?: string): Promise<void> {
  if (!paintingCommandAllowed() || sliceAdmission || useSlicerStore.getState().activeSliceTarget || useSlicerStore.getState().status === 'slicing') return;
  const targetPlateId = plateId ?? usePlateSessionStore.getState().snapshot?.currentPlateId;
  sliceAdmission = true;
  try { await sliceRequestedPlate(platform, targetPlateId); }
  finally { sliceAdmission = false; }
}

async function sliceRequestedPlate(platform: PlatformCapabilities, requestedPlateId?: string): Promise<void> {
  if (!await closePaintingForCommand()) return;
  const initialSession = usePlateSessionStore.getState().snapshot;
  const initialRevision = requestedPlateId ? initialSession?.inputRevisions?.[requestedPlateId] : undefined;
  let failureTarget: PlateOperationTarget | undefined = requestedPlateId && Number.isSafeInteger(initialRevision)
    ? { plateId: requestedPlateId, inputRevision: initialRevision! } : undefined;

  // Numeric/text fields commit on blur. A Slice click can arrive in the same
  // event turn, so wait for that Worker transaction before reading settings
  // or starting native slicing.
  await waitForConfigurationMutations();

  // Only send declared settings. Tower coordinates belong to the native scene
  // move command: the settings projection can still contain the pre-drag
  // values, which must not override the authoritative position at Slice.
  const state = useSettingsStore.getState();
  const meta = state.metadata ?? {};
  const values = Object.fromEntries(
    Object.entries(state.values).filter(([key]) =>
      meta[key] !== undefined && !SLICE_CONFIG_BLACKLIST.has(key)),
  );
  const setFailure = (message: string) => {
    const target = useSlicerStore.getState().activeSliceTarget ?? failureTarget;
    if (target) useSlicerStore.getState().setPlateFailure(target, message);
    useSlicerStore.getState().setActiveSliceTarget(null);
    useSlicerStore.getState().setStatus('error');
    useSlicerStore.getState().setError(message);
    const selected = usePlateSessionStore.getState().snapshot;
    if (target && selected && selected.currentPlateId !== target.plateId) {
      const revision = selected.inputRevisions?.[selected.currentPlateId];
      if (revision !== undefined) useSlicerStore.getState().activatePlateResult(selected.currentPlateId, revision);
    }
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
  const plateId = requestedPlateId ?? session.currentPlateId;
  const current = session.plates.find((plate) => plate.plateId === plateId);
  const revision = session.inputRevisions?.[plateId];
  failureTarget = Number.isSafeInteger(revision) ? { plateId, inputRevision: revision! } : undefined;
  if (!current || current.valid === false || !(current.instanceIds?.length) ||
      !Number.isSafeInteger(revision)) {
    setFailure(current?.valid === false ? 'target plate contains an out-of-bounds instance' : 'target plate is empty or unavailable');
    return;
  }
  const target: PlateOperationTarget = { plateId, inputRevision: revision as number };

  const slicer = useSlicerStore.getState();
  // An explicit Slice withdraws only the renderer-facing receipt/projection.
  // The Worker registry keeps its native Print/result cache for incremental
  // processing and publishes a new task-addressed receipt on success.
  slicer.invalidatePlateResults([target.plateId]);
  slicer.setProgress(0);
  slicer.setProgressText('Preparing slice');
  slicer.setStatus('slicing');
  slicer.setActiveSliceTarget(target);
  slicer.setResultExported(false);
  slicer.setError(null);
  const cancellation = { requested: false };
  activeCancellation = cancellation;
  const finishCancelled = () => {
    const live = useSlicerStore.getState();
    live.setActiveSliceTarget(null);
    live.setStatus('idle');
    live.setProgress(0);
    live.setError(null);
    const selected = usePlateSessionStore.getState().snapshot;
    const revision = selected?.inputRevisions?.[selected.currentPlateId];
    if (selected && revision !== undefined) live.activatePlateResult(selected.currentPlateId, revision);
  };
  try {
    const result = await platform.runtime.slicePlate(
      target,
      values,
      (pct, text) => {
        const live = useSlicerStore.getState();
        if (live.activeSliceTarget?.plateId !== target.plateId || live.activeSliceTarget.inputRevision !== target.inputRevision) return;
        live.setProgress(pct); live.setProgressText(text);
      },
    );
    const live = useSlicerStore.getState();
    if (!live.activeSliceTarget || live.activeSliceTarget.plateId !== target.plateId ||
        live.activeSliceTarget.inputRevision !== target.inputRevision) return;
    if (!result.ok) {
      if (cancellation.requested) { finishCancelled(); return; }
      setFailure(result.error ?? 'slice failed');
      console.error('slice failed:', result.error);
      return;
    }
    if (result.unrecognized_keys.length) {
      console.warn('unrecognized keys dropped by libslic3r:', result.unrecognized_keys);
    }
    if (!result.receipt || result.receipt.plateId !== target.plateId ||
        result.receipt.inputStamp !== target.inputRevision) {
      const received = result.receipt
        ? `${result.receipt.plateId}@${result.receipt.inputStamp}#${result.receipt.sliceTaskId}`
        : 'missing';
      setFailure(`slice result receipt did not match ${target.plateId}@${target.inputRevision} (received ${received})`);
      return;
    }
    // Native Slice completion is the global terminal. Typed-array transfer
    // and GPU construction are a later Preview-local projection and do not
    // keep slicing controls or Export blocked.
    useSlicerStore.getState().setPlateResult(result.receipt, result.warnings ?? [], result.summary);
    useSlicerStore.getState().setActiveSliceTarget(null);
    const selected = usePlateSessionStore.getState().snapshot;
    const revision = selected?.inputRevisions?.[selected.currentPlateId];
    if (selected && revision !== undefined) useSlicerStore.getState().activatePlateResult(selected.currentPlateId, revision);
  } catch (err) {
    const live = useSlicerStore.getState();
    if (!live.activeSliceTarget || live.activeSliceTarget.plateId !== target.plateId ||
        live.activeSliceTarget.inputRevision !== target.inputRevision) return;
    if (cancellation.requested) { finishCancelled(); return; }
    setFailure(errorText(err));
    console.error('slice failed:', err);
  } finally {
    if (activeCancellation === cancellation) activeCancellation = null;
  }
}

let exportInFlight = false;

/** Export the current slice through the injected host save operation. */
export async function exportGcode(platform: PlatformCapabilities): Promise<void> {
  if (exportInFlight || !paintingCommandAllowed()) return;
  exportInFlight = true;
  try {
    await runProjectMutationOperation(async () => {
      if (paintingSessionActive()) {
        const settled = await platform.runtime.settlePainting();
        if ('error' in settled) throw new Error(settled.error);
      }
      const session = await platform.runtime.getPlateSessionSnapshot();
      if (!session.ok) throw new Error(session.error);
      const slicerState = useSlicerStore.getState();
      const currentTarget = slicerState.sliceTarget;
      const revision = session.inputRevisions?.[session.currentPlateId];
      const target: PlateOperationTarget = { plateId: session.currentPlateId, inputRevision: Number(revision) };
      if (!currentTarget || currentTarget.plateId !== target.plateId || currentTarget.inputRevision !== target.inputRevision)
        throw new Error('current plate slice result is stale or unavailable');
      const receipt = slicerState.plateResults[target.plateId]?.receipt;
      if (!receipt || receipt.inputStamp !== target.inputRevision)
        throw new Error('current plate slice result is stale or unavailable');
      const fresh = await platform.runtime.exportGcodePlate({ receipt, filenameBase: projectFilenameBase(useProjectStore.getState()) });
      if (!fresh.ok) throw new Error(fresh.error ?? 'export failed');
      await platform.exports.save(fresh.fileName, fresh.bytes);
      useSlicerStore.getState().setResultExported(true);
    });
  } catch (err) {
    useSlicerStore.getState().setError(`export: ${errorText(err)}`);
    console.error('export failed:', err);
  } finally {
    exportInFlight = false;
  }
}
