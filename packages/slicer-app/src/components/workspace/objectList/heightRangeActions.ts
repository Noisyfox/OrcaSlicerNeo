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
  const prepared = await prepareObjectListMutation();
  if (!prepared.ok) return { ok: false, error: prepared.error ?? 'Height range edit unavailable' };
  const generation = useProjectStore.getState().projectGeneration;
  const list = useObjectListStore.getState();
  const previous = list.heightRangeSelection;
  try {
    const history = await runProjectHistoryMutation(runtime, labels[command.operation],
      () => runtime.editHeightRanges(command), scene, {
        publish: async result => {
          if (result.ok && result.changed) await refreshAfterModelMutation(runtime, result.plateSession);
        },
      });
    const result = history.result;
    if (!result.ok) throw new Error(result.error);
    if (generation !== useProjectStore.getState().projectGeneration) return result;
    const structure = await runtime.getModelStructure();
    if (!structure.ok) throw new Error(structure.error);
    list.setStructure(structure.objects);
    const object = structure.objects.find(o => o.id === command.objectId);
    const keepGroup = previous?.objectId === object?.id && previous?.bounds === 'all' &&
      (command.operation === 'set' || command.operation === 'reset');
    list.selectRanges(object?.heightRanges?.length ? {
      objectId: object.id, instanceId: instanceId ?? (previous?.objectId === object.id ? previous.instanceId : undefined),
      bounds: keepGroup || result.selection.length === 0 ? 'all' : result.selection,
    } : null);
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
