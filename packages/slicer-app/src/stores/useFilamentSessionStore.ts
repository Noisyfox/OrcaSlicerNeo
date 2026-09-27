import { create } from 'zustand';
import type {
  FilamentAssignmentRequest,
  FilamentCommandRequest,
  FilamentMutationResultOrError,
  FilamentSessionSnapshot,
  FilamentSessionSnapshotResult,
  FilamentSlotColourRequest,
  FilamentSlotDeleteRequest,
  FilamentSlotMergeRequest,
  FilamentSlotPresetRequest,
  SlicerClient,
} from '@slicer/client';
import { applyFilamentMutationResult } from './plateResultLifecycle';
import { usePlateSessionStore } from './usePlateSessionStore';
import { enqueueProjectMutationOperation, type ProjectMutationLease } from '../history/projectMutationGate';
import { projectHistoryStatus } from '../history/projectHistoryStatus';
import { glVolumeCollection } from '../components/workspace/viewport/GLVolume';
import { readSceneDeltaProjection } from '../components/workspace/viewport/sceneDeltaProjection';
import { useObjectListStore } from '../components/workspace/objectList/useObjectListStore';
import { useSettingsStore } from './useSettingsStore';

/**
 * UI state for the material rack. `snapshot` is always the last complete
 * Worker projection; commands never edit it optimistically. This keeps the
 * native session as the only source of truth while still allowing React to
 * render pending and rejected command state.
 */
interface FilamentSessionState {
  snapshot: FilamentSessionSnapshot | null;
  pendingKind: string | null;
  rejected: string | null;
  /** Publish a complete rack snapshot returned by a composite native receipt. */
  publish: (snapshot: FilamentSessionSnapshot) => void;
  load: (runtime: SlicerClient) => Promise<FilamentSessionSnapshotResult>;
  refresh: (runtime: Pick<SlicerClient, 'getFilamentSessionSnapshot'>, isCurrent?: () => boolean, lease?: ProjectMutationLease) => Promise<FilamentSessionSnapshotResult>;
  run: (runtime: SlicerClient, command: () => Promise<FilamentMutationResultOrError>) => Promise<FilamentMutationResultOrError>;
  clearRejected: () => void;
  reset: () => void;
}

let pendingFilamentOperations = 0;

function isSnapshot(result: FilamentSessionSnapshotResult): result is FilamentSessionSnapshot {
  return result.ok === true && Array.isArray(result.slots);
}

/**
 * A filament receipt contains the authoritative input revision for every
 * plate it changed. Keep the separate plate-session projection coherent
 * before dependent scene work (notably a Prime Tower pointer-up) can read it.
 */
function projectFilamentPlateRevisions(snapshot: FilamentSessionSnapshot): void {
  const plateSession = usePlateSessionStore.getState();
  const current = plateSession.snapshot;
  if (!current) return;
  const inputRevisions = { ...current.inputRevisions };
  let changed = false;
  for (const plate of current.plates) {
    const revision = snapshot.revisions.plates[plate.plateId];
    if (!Number.isSafeInteger(revision) || inputRevisions[plate.plateId] === revision) continue;
    inputRevisions[plate.plateId] = revision;
    changed = true;
  }
  if (changed) plateSession.setSnapshot({ ...current, inputRevisions });
}

async function readFilamentSnapshot(
  runtime: Pick<SlicerClient, 'getFilamentSessionSnapshot'>,
  set: (state: Partial<FilamentSessionState>) => void,
  isCurrent: () => boolean,
): Promise<FilamentSessionSnapshotResult> {
  try {
    const result = await runtime.getFilamentSessionSnapshot();
    if (!isCurrent()) return result;
    if (isSnapshot(result)) set({ snapshot: result, rejected: null });
    else set({ rejected: result.error });
    return result;
  } catch (error) {
    const result = {
      ok: false as const,
      version: 1 as const,
      error: error instanceof Error ? error.message : String(error),
      errorCode: 'runtime_failure',
    };
    if (isCurrent()) set({ rejected: result.error });
    return result;
  }
}

/** Slot deletion/merge rewrites native facet states without changing object
 * membership. Replace only the painted display resources before publishing
 * the new rack palette, while retaining the original mesh and BVH. */
async function refreshRemappedPaint(runtime: SlicerClient): Promise<void> {
  const previous = glVolumeCollection.volumes;
  const touched = [...new Set(previous.filter((volume) => volume.paintGeometryKey !== null)
    .map((volume) => volume.buffer.objectId))];
  if (touched.length === 0) return;
  const structure = useObjectListStore.getState().structure;
  const revision = useSettingsStore.getState().modelRevision;
  const delta = {
    version: 1 as const,
    objectIds: touched,
    volumeIds: [], instanceIds: [], plateIds: [],
    objectOrder: structure.map((object) => object.id),
  };
  const projection = await readSceneDeltaProjection(runtime, delta, structure, previous);
  if (useSettingsStore.getState().modelRevision !== revision || glVolumeCollection.volumes !== previous) {
    const retained = new Set(previous);
    projection.volumes.forEach((volume) => { if (!retained.has(volume)) volume.dispose(); });
    throw new Error('filament paint projection was superseded');
  }
  projection.apply();
  glVolumeCollection.patch(projection.volumes, revision);
}

export const useFilamentSessionStore = create<FilamentSessionState>((set) => ({
  snapshot: null,
  pendingKind: null,
  rejected: null,
  publish: (snapshot) => set({ snapshot, rejected: null }),
  load: (runtime): Promise<FilamentSessionSnapshotResult> => enqueueProjectMutationOperation(
    () => readFilamentSnapshot(runtime, set, () => true),
  ),
  refresh: (runtime, isCurrent = () => true, lease): Promise<FilamentSessionSnapshotResult> =>
    lease ? readFilamentSnapshot(runtime, set, isCurrent) : enqueueProjectMutationOperation(
      () => readFilamentSnapshot(runtime, set, isCurrent),
    ),
  run: async (runtime, command) => {
    pendingFilamentOperations += 1;
    set({ pendingKind: 'mutation', rejected: null });
    return enqueueProjectMutationOperation(async () => {
      try {
        const result = await command();
        if (result.ok) {
          if (result.result.mutation.kind === 'delete' || result.result.mutation.kind === 'merge')
            await refreshRemappedPaint(runtime);
          // The native command and this receipt share one commit. Project it
          // before any dependent session/result publication; do not issue a
          // competing history-status read from this FIFO operation.
          projectHistoryStatus(result.result.historyStatus);
          set({ snapshot: result.result.snapshot, rejected: null });
          projectFilamentPlateRevisions(result.result.snapshot);
          await applyFilamentMutationResult(result.result.mutation, runtime);
        }
        else set({ rejected: result.error });
        return result;
      } catch (error) {
        const rejected = String(error);
        set({ rejected });
        return { ok: false, version: 1, error: rejected, errorCode: 'runtime_failure' };
      } finally {
        pendingFilamentOperations -= 1;
        if (pendingFilamentOperations === 0) set({ pendingKind: null });
      }
    });
  },
  clearRejected: () => set({ rejected: null }),
  reset: () => set({ snapshot: null, pendingKind: null, rejected: null }),
}));

/** Refresh the complete Worker projection after a model/project replacement.
 * Callers may fence publication when a newer history restore supersedes the
 * request. */
export async function refreshFilamentSession(
  runtime: Pick<SlicerClient, 'getFilamentSessionSnapshot'>,
  isCurrent?: () => boolean,
  lease?: ProjectMutationLease,
): Promise<FilamentSessionSnapshotResult> {
  return useFilamentSessionStore.getState().refresh(runtime, isCurrent, lease);
}

/** A model transform advances History and plate inputs but cannot change the
 * filament rack, assignments, flushing values, or capabilities. Project the
 * committed revision receipt onto the retained snapshot instead of paying for
 * a full Worker snapshot read on the latency-critical pointer-release path. */
export function projectFilamentHistoryRevision(
  historyRevision: number,
  plateInputRevisions?: Readonly<Record<string, number>>,
): void {
  if (!Number.isSafeInteger(historyRevision)) return;
  const snapshot = useFilamentSessionStore.getState().snapshot;
  if (!snapshot) return;
  // These are optimistic-concurrency tokens, not renderable rack data. Keep
  // the retained snapshot identity so every ModelMesh/FilamentRack subscriber
  // is not synchronously rerendered for a value that none of them displays.
  // All command builders read the token through getState() at dispatch time.
  const revisions = snapshot.revisions as {
    session: number; project: number; plates: Record<string, number>;
  };
  revisions.session = historyRevision;
  revisions.project = historyRevision;
  if (plateInputRevisions) revisions.plates = { ...plateInputRevisions };
}

export type FilamentMutationRequest =
  | FilamentSlotPresetRequest
  | FilamentSlotColourRequest
  | FilamentCommandRequest
  | FilamentSlotDeleteRequest
  | FilamentSlotMergeRequest
  | FilamentAssignmentRequest;
