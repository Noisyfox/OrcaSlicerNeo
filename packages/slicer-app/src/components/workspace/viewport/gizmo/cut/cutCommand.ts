import type { PlatformCapabilities } from '@orca/platform-contract';
import type { CutRequest, CutResult } from '@slicer/client';
import { loadMeshBooleanPreferences, useMeshBooleanStore } from '@/stores/useMeshBooleanStore';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { runProjectHistoryMutation } from '../../../actions/historyMutation';
import { prepareObjectListMutation, refreshAfterModelMutation } from '../../../objectList/actions';
import { glVolumeCollection } from '../../GLVolume';
import type { SceneInteractionController } from '../../SceneInteractionController';
import { beforePaintingTopologyChange } from '../painting/projectCommands';

export async function applyCut(
  platform: Pick<PlatformCapabilities, 'runtime' | 'preferences'>,
  draft: Omit<CutRequest, 'keepPainting'>,
  scene: SceneInteractionController,
): Promise<CutResult> {
  const { runtime } = platform;
  try {
    const prepared = await prepareObjectListMutation();
    if (!prepared.ok) throw new Error(prepared.error ?? 'Finish the current edit before cutting');
    if (!await beforePaintingTopologyChange({ objects: [draft.objectId] }))
      throw new Error('Finish painting before cutting');
    await loadMeshBooleanPreferences(platform.preferences);
    const request = { ...draft, keepPainting: useMeshBooleanStore.getState().keepPainting };
    const committed = await runProjectHistoryMutation<CutResult>(runtime, 'Cut by plane',
      () => runtime.applyCut(request), scene, {
        contextReceipt: result => {
          if (!result.ok || !result.changed) return { structure: 'preserved',
            activePlateId: usePlateSessionStore.getState().snapshot?.currentPlateId ?? null };
          const outputs = result.objects.filter(object => result.newObjectIds.includes(object.id));
          return { structure: { ok: true, objects: result.objects }, activePlateId: result.plateSession.currentPlateId,
            selection: { mode: 'object', objectIds: result.newObjectIds, partIds: [],
              instanceIds: outputs.flatMap(object => object.instances.map(instance => instance.id)) } };
        },
        publish: async result => {
          if (!result.ok || !result.changed) return;
          await refreshAfterModelMutation(runtime, result.plateSession);
          scene.setSelectionMode('object');
          scene.selectVolumeIds(glVolumeCollection.volumes.filter(v => result.newObjectIds.includes(v.buffer.objectId)).map(v => v.id));
        },
      });
    return committed.result;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
