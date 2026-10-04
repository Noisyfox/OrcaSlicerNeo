import type { PlatformCapabilities } from '@orca/platform-contract';
import type { ModelStructureResult, AddVolumeRequest, ModelObjectStructure, VolumeType } from '@slicer/client';
import type { SelectionProjection } from './projection';
import { prepareObjectListMutation, refreshAfterModelMutation } from './actions';
import { beforePaintingTopologyChange } from '../viewport/gizmo/painting/projectCommands';
import { runProjectHistoryMutation } from '../actions/historyMutation';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { useSlicerStore } from '@/stores/useSlicerStore';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { errorText } from '@orca/slicer-runtime';

export const ADD_VOLUME_MENUS: readonly { type: VolumeType; label: string }[] = [
  { type: 'model_part', label: 'Add Part' },
  { type: 'negative_volume', label: 'Add Negative Part' },
  { type: 'parameter_modifier', label: 'Add Modifier' },
  { type: 'support_blocker', label: 'Add Support Blocker' },
  { type: 'support_enforcer', label: 'Add Support Enforcer' },
];

/** Orca accepts one full object or one full instance, never partial/multiple selections. */
export function addVolumeAnchor(object: ModelObjectStructure, selection: SelectionProjection): number | null {
  if (selection.volumeIds.size > 0) return null;
  if (selection.objectIds.size === 1 && selection.objectIds.has(object.id) && selection.instanceIds.size === 0)
    return object.instances[0]?.id ?? null;
  if (selection.objectIds.size > 0) return null;
  const instances = [...selection.instanceIds];
  if (instances.length === 1 && object.instances.some((i) => i.id === instances[0])) return instances[0];
  // The Instances group represents a full object when every instance is selected.
  if (instances.length === object.instanceCount && instances.length > 0
      && object.instances.every((i) => selection.instanceIds.has(i.id))) return object.instances[0]?.id ?? null;
  return null;
}

export async function addVolumeInList(
  platform: PlatformCapabilities,
  target: { objectId: number; instanceId: number; volumeType: VolumeType },
  shape?: string,
  sceneInteraction?: SceneInteractionController | null,
): Promise<void> {
  try {
    const prepared = await prepareObjectListMutation();
    if (!prepared.ok) { if (prepared.error) throw new Error(prepared.error); return; }
    const file = shape ? null : await platform.models.pick();
    if (!shape && !file) return;
    if (!await beforePaintingTopologyChange({ objects: [target.objectId] })) return;
    const settled = await prepareObjectListMutation();
    if (!settled.ok) { if (settled.error) throw new Error(settled.error); return; }
    const request: AddVolumeRequest = shape ? { ...target, shape }
      : { ...target, ext: file!.displayName.split('.').pop()?.toLowerCase() ?? 'stl', name: file!.displayName };
    let structure: ModelStructureResult | undefined;
    const history = await runProjectHistoryMutation(platform.runtime, `Add ${shape ?? file!.displayName}`,
      async () => {
        const result = await platform.runtime.addVolume(request, file?.bytes);
        if (result.ok) {
          structure = await platform.runtime.getModelStructure();
          if (!structure.ok) throw new Error(structure.error ?? 'Unable to refresh added part');
        }
        return result;
      }, sceneInteraction, {
        contextReceipt: (result) => ({
          structure: structure?.ok ? { ...structure, ok: true } : 'preserved',
          activePlateId: usePlateSessionStore.getState().snapshot?.currentPlateId ?? null,
          selection: { mode: 'part', objectIds: [], partIds: result.volumeId ? [result.volumeId] : [], instanceIds: [target.instanceId] },
        }),
        publish: async (result) => {
          if (result.ok) {
            await refreshAfterModelMutation(platform.runtime, result.plateSession);
            const object = structure?.objects?.find((o) => o.id === target.objectId);
            const volume = object?.volumes.find((v) => v.id === result.volumeId);
            const instance = object?.instances.find((i) => i.id === target.instanceId);
            if (object && volume && instance) sceneInteraction?.selectComposite(object.index, volume.index, instance.index, false);
          }
        },
      });
    if (!history.result.ok) throw new Error(history.result.error ?? 'Unable to add part');
  } catch (error) {
    useSlicerStore.getState().setError(errorText(error));
  }
}
