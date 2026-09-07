import type { PlatformCapabilities } from '@orca/platform-contract';
import type { HistoryContext, PlateSessionMutationResult, PlateSessionSnapshotResult } from '@slicer/client';
import { glVolumeCollection } from './viewport/GLVolume';
import { usePlateSessionStore } from '../../stores/usePlateSessionStore';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { applyPlateSessionTransforms } from './actions/syncModelTransforms';

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

/** Select by immutable plate identity through the authoritative runtime. */
export async function selectPlateSession(
  platform: PlatformCapabilities,
  plateId: string,
): Promise<boolean> {
  const current = usePlateSessionStore.getState().snapshot?.currentPlateId;
  if (current === plateId) return true;
  return applyPlateSessionResponse(platform, await platform.runtime.selectPlate(plateId));
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
    const record = platform.runtime.recordHistoryContext;
    if (typeof record === 'function') {
      const context: HistoryContext = {
        selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
        activePlateId: usePlateSessionStore.getState().snapshot?.currentPlateId ?? plateId,
        gizmo: null,
        projectConfigOverlay: useSettingsStore.getState().overlay as unknown as HistoryContext['projectConfigOverlay'],
      };
      await record.call(platform.runtime, 'Active Plate', context).catch(() => undefined);
    }
  }
  return selected;
}

/** Structural mutations retain the existing project dirty-state semantics. */
export function recordPlateMutation(result: PlateSessionMutationResult): void {
  if (result.ok) useProjectStore.getState().recordPlateMutation(result);
}
