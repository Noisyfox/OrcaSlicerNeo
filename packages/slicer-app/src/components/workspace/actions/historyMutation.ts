import type {
  HistoryContext,
  HistoryStatus,
  SlicerClient,
} from '@slicer/client';
import type { SlicerRuntime } from '@orca/platform-contract';
import { useObjectListStore } from '../objectList/useObjectListStore';
import { projectSelection } from '../objectList/projection';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';

export type HistoryMutationResult<T> = {
  result: T;
  status: HistoryStatus | null;
};

/** Build a JSON-safe context from the current stable-ID ObjectList projection. */
export function historyContextForStructure(sceneInteraction?: SceneInteractionController | null): HistoryContext {
  const objectList = useObjectListStore.getState();
  const projection = sceneInteraction
    ? projectSelection(
      objectList.structure,
      sceneInteraction.selectedVolumes().map((volume) => volume.buffer),
      objectList.highlightLevel,
    )
    : objectList.projection;
  const mode = sceneInteraction?.selectionMode === 'volume'
    ? 'part'
    : sceneInteraction?.selectionMode ?? (projection.volumeIds.size > 0 ? 'part' : 'object');
  return {
    selection: {
      mode,
      objectIds: [...projection.objectIds].sort((a, b) => a - b),
      partIds: [...projection.volumeIds].sort((a, b) => a - b),
      instanceIds: [...projection.instanceIds].sort((a, b) => a - b),
    },
    activePlateId: usePlateSessionStore.getState().snapshot?.currentPlateId ?? null,
    gizmo: sceneInteraction?.gizmo ? { type: sceneInteraction.gizmo } : null,
    projectConfigOverlay: {},
  };
}

type MutationResponse = { ok?: boolean; error?: string };

/**
 * Run one project mutation through the Worker-owned history transaction.
 * The compatibility path is only for old test doubles; production runtimes
 * implement the method through SlicerRuntime's required HistoryRuntimeMethods.
 */
export async function runProjectHistoryMutation<T extends MutationResponse>(
  runtime: Partial<Pick<SlicerRuntime, 'runProjectHistoryTransaction' | 'getHistoryStatus'>>,
  label: string,
  mutation: () => Promise<T>,
  sceneInteraction?: SceneInteractionController | null,
): Promise<HistoryMutationResult<T>> {
  const transaction = runtime.runProjectHistoryTransaction;
  if (typeof transaction !== 'function') {
    return { result: await mutation(), status: null };
  }
  const before = historyContextForStructure(sceneInteraction);
  try {
    const response = await transaction.call(
      runtime as SlicerClient,
      label,
      'project',
      before,
      async () => {
        const result = await mutation();
        if (result.ok !== true) throw new Error(result.error ?? `${label} failed`);
        return result;
      },
      () => historyContextForStructure(sceneInteraction),
    ) as unknown as HistoryMutationResult<T>;
    return response;
  } catch (error) {
    const status = typeof runtime.getHistoryStatus === 'function'
      ? await runtime.getHistoryStatus().catch(() => null)
      : null;
    return {
      result: { ok: false, error: error instanceof Error ? error.message : String(error) } as T,
      status,
    };
  }
}

/** Keep the renderer's dirty projection aligned with the Worker checkpoint. */
export async function syncHistoryStatus(runtime: Partial<Pick<SlicerRuntime, 'getHistoryStatus'>>): Promise<HistoryStatus | null> {
  if (typeof runtime.getHistoryStatus !== 'function') return null;
  try {
    const status = await runtime.getHistoryStatus();
    useProjectStore.getState().setProject({ dirty: status.dirty, dirtyReasons: [] });
    return status;
  } catch {
    return null;
  }
}
