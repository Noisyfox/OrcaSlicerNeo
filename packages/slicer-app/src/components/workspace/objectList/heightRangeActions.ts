import type { SlicerRuntime } from '@orca/platform-contract';
import type { HeightRangeCommand, HeightRangeEditResult } from '@slicer/client';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { runProjectHistoryMutation } from '../actions/historyMutation';
import { prepareObjectListMutation, refreshAfterModelMutation } from './actions';
import { useObjectListStore } from './useObjectListStore';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';

const labels: Record<HeightRangeCommand['operation'], string> = {
  initialize: 'Add Height Range Modifier', append: 'Add Height Range', remove: 'Delete Height Ranges',
  min: 'Move Height Range Start', max: 'Move Height Range End', set: 'Edit Height Range Settings',
  reset: 'Reset Height Range Setting', paste: 'Paste Height Ranges',
};
export async function editRanges(runtime: SlicerRuntime, command: HeightRangeCommand,
  scene?: SceneInteractionController | null, instanceId?: number): Promise<HeightRangeEditResult> {
  const list = useObjectListStore.getState();
  const previous = list.heightRangeSelection;
  const prepared = await prepareObjectListMutation();
  if (!prepared.ok) return { ok: false, error: prepared.error ?? 'Height range edit unavailable' };
  const generation = useProjectStore.getState().projectGeneration;
  try {
    const history = await runProjectHistoryMutation(runtime, labels[command.operation],
      () => runtime.editHeightRanges(command), scene, {
        publish: async (result, _status, delta) => {
          if (!result.ok || generation !== useProjectStore.getState().projectGeneration) return;
          if (result.changed) await refreshAfterModelMutation(runtime, result.plateSession);
          if (!delta && result.changed) {
            const structure = await runtime.getModelStructure();
            if (!structure.ok) throw new Error(structure.error);
            list.setStructure(structure.objects);
          }
          const current = useObjectListStore.getState();
          // A blur can save just as the user selects a different tree item.
          if (current.rangeSelectionRevision !== list.rangeSelectionRevision) return;
          const object = current.structure.find(o => o.id === command.objectId);
          const keepGroup = previous?.objectId === command.objectId && previous.bounds === 'all' &&
            command.operation !== 'paste';
          if (keepGroup && current.heightRangeSelection === previous) return;
          list.selectRanges(object?.heightRanges?.length ? {
            objectId: object.id, instanceId: instanceId ?? (previous?.objectId === object.id ? previous.instanceId : undefined),
            bounds: keepGroup || result.selection.length === 0 ? 'all' : result.selection,
          } : null);
        },
      });
    const result = history.result;
    if (!result.ok) throw new Error(result.error);
    return result;
  } catch (reason) {
    const error = reason instanceof Error ? reason.message : String(reason);
    useSlicerStore.getState().setError(error);
    return { ok: false, error };
  }
}

export async function openRanges(runtime: SlicerRuntime, objectId: number, instanceId?: number, scene?: SceneInteractionController | null) {
  useSettingsStore.getState().setConfigurationMode('scoped');
  const list = useObjectListStore.getState();
  if (list.structure.find(object => object.id === objectId)?.heightRanges?.length) {
    list.selectRanges({ objectId, instanceId, bounds: 'all' });
    return;
  }
  await editRanges(runtime, { operation: 'initialize', objectId }, scene, instanceId);
}
