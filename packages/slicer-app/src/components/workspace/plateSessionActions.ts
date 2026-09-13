import type { PlatformCapabilities } from '@orca/platform-contract';
import type { HistoryContext, PlateSessionMutationResult, PlateSessionSnapshotResult, PrimeTowerMoveMutation } from '@slicer/client';
import { glVolumeCollection } from './viewport/GLVolume';
import { usePlateSessionStore } from '../../stores/usePlateSessionStore';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { applyPlateSessionTransforms } from './actions/syncModelTransforms';
import { recordProjectHistoryContext } from './actions/historyMutation';

/**
 * Apply the complete result of a runtime plate transaction.  Both Prepare's
 * bed picking and Preview's sidebar use this path so result activation,
 * invalidation, and reflowed instance transforms cannot drift apart.
 */
export function applyPlateSessionResponse(
  platform: PlatformCapabilities,
  result: PlateSessionSnapshotResult | PlateSessionMutationResult,
): boolean {
  if (!result.ok) {
    useSlicerStore.getState().setError(result.error);
    return false;
  }
  const previous = usePlateSessionStore.getState().snapshot;
  const slicer = useSlicerStore.getState();
  const activeJob = slicer.activeSliceTarget;
  const affected = result.affectedPlateIds ?? [];
  const structural = result.dirtyReasons?.includes('plate-structure') ?? false;
  if (!structural && activeJob && affected.includes(activeJob.plateId)) {
    slicer.invalidatePlateResults([activeJob.plateId]);
    void platform.runtime.cancel().catch(() => undefined);
  } else if (!structural && affected.length) {
    slicer.invalidatePlateResults(affected);
  }
  if (structural && previous) {
    const nextIds = new Set(result.plates.map((plate) => plate.plateId));
    const removed = previous.plates.filter((plate) => !nextIds.has(plate.plateId)).map((plate) => plate.plateId);
    for (const plateId of removed) slicer.discardPlateResult(plateId);
    if (activeJob && removed.includes(activeJob.plateId)) {
      slicer.invalidatePlateResults([activeJob.plateId]);
      void platform.runtime.cancel().catch(() => undefined);
    }
  }
  usePlateSessionStore.getState().setSnapshot(result);
  if (result.instanceTransforms) {
    applyPlateSessionTransforms({ instanceTransforms: result.instanceTransforms }, glVolumeCollection.volumes);
  }
  const revision = result.inputRevisions?.[result.currentPlateId];
  if (typeof revision === 'number' && Number.isSafeInteger(revision)) {
    useSlicerStore.getState().activatePlateResult(result.currentPlateId, revision);
  }
  return true;
}

/** Apply the deliberately narrow, plate-local response from a Prime Tower move. */
export function applyPrimeTowerMoveMutation(
  platform: PlatformCapabilities,
  mutation: PrimeTowerMoveMutation,
): boolean {
  const previous = usePlateSessionStore.getState().snapshot;
  if (!previous || !previous.plates.some((plate) => plate.plateId === mutation.plateId)) return false;
  const slicer = useSlicerStore.getState();
  if (mutation.affectedPlateIds.includes(mutation.plateId)) {
    slicer.invalidatePlateResults([mutation.plateId]);
    if (slicer.activeSliceTarget?.plateId === mutation.plateId)
      void platform.runtime.cancel().catch(() => undefined);
  }
  usePlateSessionStore.getState().setSnapshot({
    ...previous,
    inputRevisions: { ...previous.inputRevisions, [mutation.plateId]: mutation.revisionAfter },
  });
  return true;
}

/** Select by immutable plate identity through the authoritative runtime. */
export async function selectPlateSession(
  platform: PlatformCapabilities,
  plateId: string,
): Promise<boolean> {
  const current = usePlateSessionStore.getState().snapshot?.currentPlateId;
  if (current === plateId) return true;
  const result = await platform.runtime.selectPlate(plateId);
  if (!result.ok) {
    useSlicerStore.getState().setError(result.error);
    return false;
  }
  const previous = usePlateSessionStore.getState().snapshot;
  if (!previous || !previous.plates.some((plate) => plate.plateId === result.currentPlateId)) {
    useSlicerStore.getState().setError('plate selection returned an unknown plate');
    return false;
  }
  usePlateSessionStore.getState().setSnapshot({ ...previous, currentPlateId: result.currentPlateId });
  const revision = previous.inputRevisions?.[result.currentPlateId];
  if (typeof revision === 'number' && Number.isSafeInteger(revision))
    useSlicerStore.getState().activatePlateResult(result.currentPlateId, revision);
  return true;
}

/** Select a different plate and clear the shared object selection only after
 * the authoritative transaction succeeds.  Plate clicks are navigation, so
 * the selection must not follow the previous plate into the new context. */
export async function selectPlateSessionAndClearSelection(
  platform: PlatformCapabilities,
  plateId: string,
  clearSelection: () => void,
): Promise<boolean> {
  if (usePlateSessionStore.getState().snapshot?.currentPlateId === plateId) {
    clearSelection();
    return false;
  }
  const selected = await selectPlateSession(platform, plateId);
  if (selected) {
    clearSelection();
    // Plate navigation is a context-only history record. It must not create a
    // project step or dirty the project, but restored project frames should
    // retain the active stable plate identity.
    const context: HistoryContext = {
      selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
      activePlateId: usePlateSessionStore.getState().snapshot?.currentPlateId ?? plateId,
      gizmo: null,
      projectConfigOverlay: useSettingsStore.getState().overlay as unknown as HistoryContext['projectConfigOverlay'],
    };
    await recordProjectHistoryContext(platform.runtime, 'Active Plate', context).catch(() => undefined);
  }
  return selected;
}

/** Structural mutations retain the existing project dirty-state semantics. */
export function recordPlateMutation(result: PlateSessionMutationResult): void {
  if (result.ok) useProjectStore.getState().recordPlateMutation(result);
}
