import type {
  HistoryContext,
  HistoryStatus,
} from '@slicer/client';
import type { SlicerRuntime } from '@orca/platform-contract';
import { useObjectListStore } from '../objectList/useObjectListStore';
import { projectSelection } from '../objectList/projection';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { useHistoryNavigationStore } from '../../../stores/useHistoryNavigationStore';
import { refreshFilamentSession } from '../../../stores/useFilamentSessionStore';

export type HistoryMutationResult<T> = {
  result: T;
  status: HistoryStatus | null;
};

type HistoryMutationRuntime = Pick<SlicerRuntime, 'runProjectHistoryTransaction'> &
  Pick<SlicerRuntime, 'getFilamentSessionSnapshot'> &
  Partial<Pick<SlicerRuntime, 'getHistoryStatus' | 'getModelStructure' | 'getPlateSessionSnapshot'>>;

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
    projectConfigOverlay: useSettingsStore.getState().overlay as unknown as HistoryContext['projectConfigOverlay'],
  };
}

/** Remove IDs that a structural mutation deleted before its renderer refresh. */
function projectContextOntoStructure(context: HistoryContext, structure: Awaited<ReturnType<SlicerRuntime['getModelStructure']>>): HistoryContext {
  if (!structure.ok || !structure.objects) return context;
  const objectIds = new Set(structure.objects.map((object) => object.id));
  const partIds = new Set(structure.objects.flatMap((object) => object.volumes.map((volume) => volume.id)));
  const instanceIds = new Set(structure.objects.flatMap((object) => object.instances.map((instance) => instance.id)));
  return {
    ...context,
    selection: {
      ...context.selection,
      objectIds: context.selection.objectIds.filter((id) => objectIds.has(id)),
      partIds: context.selection.partIds.filter((id) => partIds.has(id)),
      instanceIds: context.selection.instanceIds.filter((id) => instanceIds.has(id)),
    },
  };
}

type MutationResponse = { ok?: boolean; error?: string };
export interface ProjectHistoryMutationOptions {
  /** The caller owns a fence that must span post-transaction rendering work. */
  fenceProjectMutation?: boolean;
}

/** Run one project mutation through the Worker-owned history transaction. */
export async function runProjectHistoryMutation<T extends MutationResponse>(
  runtime: HistoryMutationRuntime,
  label: string,
  mutation: () => Promise<T>,
  sceneInteraction?: SceneInteractionController | null,
  options: ProjectHistoryMutationOptions = {},
): Promise<HistoryMutationResult<T>> {
  const before = historyContextForStructure(sceneInteraction);
  // A project history commit advances the native filament-session revision
  // even when the mutation itself does not touch materials. Hold the shared
  // mutation fence until the complete post-commit projection is published so
  // a filament command cannot read the preceding revision in that window.
  const ownsProjectFence = options.fenceProjectMutation !== false;
  if (ownsProjectFence) useProjectStore.getState().beginProjectMutation();
  try {
    try {
      const response = await runtime.runProjectHistoryTransaction(
        label,
        'project',
        before,
        async () => {
          const result = await mutation();
          if (result.ok !== true) throw new Error(result.error ?? `${label} failed`);
          return result;
        },
        async () => {
          let context = historyContextForStructure(sceneInteraction);
          const structure = typeof runtime.getModelStructure === 'function'
            ? await runtime.getModelStructure().catch(() => null)
            : null;
          if (structure) context = projectContextOntoStructure(context, structure);
          const plateSession = typeof runtime.getPlateSessionSnapshot === 'function'
            ? await runtime.getPlateSessionSnapshot().catch(() => null)
            : null;
          if (plateSession?.ok) context = { ...context, activePlateId: plateSession.currentPlateId };
          return context;
        },
      ) as unknown as HistoryMutationResult<T>;
      await refreshFilamentSession(runtime);
      return response;
    } catch (error) {
      const status = typeof runtime.getHistoryStatus === 'function'
        ? await runtime.getHistoryStatus().catch(() => null)
        : null;
      if (status) projectHistoryStatus(status);
      await refreshFilamentSession(runtime);
      return {
        result: { ok: false, error: error instanceof Error ? error.message : String(error) } as T,
        status,
      };
    }
  } finally {
    if (ownsProjectFence) useProjectStore.getState().endProjectMutation();
  }
}

/** Keep the renderer's dirty projection aligned with the Worker checkpoint. */
export function projectHistoryStatus(status: HistoryStatus): HistoryStatus {
  useHistoryNavigationStore.getState().setStatus(status);
  useProjectStore.getState().setProject({ dirty: status.dirty, dirtyReasons: [] });
  return status;
}

/** Read and project the Worker's current checkpoint state. */
export async function syncHistoryStatus(runtime: Partial<Pick<SlicerRuntime, 'getHistoryStatus'>>): Promise<HistoryStatus | null> {
  if (typeof runtime.getHistoryStatus !== 'function') return null;
  try {
    const status = await runtime.getHistoryStatus();
    return projectHistoryStatus(status);
  } catch {
    return null;
  }
}
