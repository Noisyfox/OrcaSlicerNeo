import type { MeshBooleanRequest, MeshBooleanResult } from '@slicer/client';
import type { PlatformCapabilities, SlicerRuntime } from '@orca/platform-contract';
import { loadMeshBooleanPreferences, useMeshBooleanStore } from '@/stores/useMeshBooleanStore';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { runExclusiveProjectOperation, runProjectHistoryMutation } from '../../../actions/historyMutation';
import { prepareObjectListMutation, refreshAfterModelMutation } from '../../../objectList/actions';
import { glVolumeCollection } from '../../GLVolume';
import type { SceneInteractionController } from '../../SceneInteractionController';
import { beforePaintingTopologyChange, closePaintingForCommand } from '../painting/projectCommands';

let preparing = false;
function notify(message: string, severity: 'warning' | 'error'): void {
  const notifications = useNotificationStore.getState();
  const token = notifications.beginOperation({ key: 'mesh-boolean', title: 'Mesh Boolean', message, severity,
    plateId: usePlateSessionStore.getState().snapshot?.currentPlateId ?? '' });
  notifications.finishOperation(token, { title: 'Mesh Boolean', message, severity });
}

/** Hold both the application lane and Worker transport until the committed
 * scene, plate receipts and ordinary selection have all been published. */
export async function executeMeshBoolean(
  platform: Pick<PlatformCapabilities, 'runtime' | 'preferences'>,
  request: MeshBooleanRequest,
  scene: SceneInteractionController | null,
): Promise<MeshBooleanResult> {
  if (preparing || useMeshBooleanStore.getState().busy) return { ok: false, error: 'mesh_boolean_busy' };
  preparing = true;
  try {
    if (platform.runtime.getRuntimeExecutionState?.().sliceActive) throw new Error('Finish slicing before using Mesh Boolean');
    const prepared = await prepareObjectListMutation();
    if (!prepared.ok) throw new Error(prepared.error ?? 'Finish the current operation before using Mesh Boolean');
    if (!await beforePaintingTopologyChange({ objects: [request.objectId] })) throw new Error('Finish painting before using Mesh Boolean');
    if (!await closePaintingForCommand()) throw new Error('Finish painting before using Mesh Boolean');
    await loadMeshBooleanPreferences(platform.preferences);
    return await runExclusiveProjectOperation(admission => platform.runtime.runMeshBooleanOperation(async owner => {
      // The scoped transport exposes the same core methods used by history
      // and plate publication; no host/runtime extension is called here.
      const runtime = owner as SlicerRuntime;
      useMeshBooleanStore.setState({ busy: true });
      if (scene) scene.meshBoolean.publishing = true;
      try {
        const command = { ...request, keepPainting: useMeshBooleanStore.getState().keepPainting };
        const committed = await runProjectHistoryMutation<MeshBooleanResult>(runtime, 'Mesh Boolean',
          () => runtime.meshBoolean(command), scene, {
            admission,
            contextReceipt: result => {
              if (!result.ok || !result.changed) return { structure: 'preserved',
                activePlateId: usePlateSessionStore.getState().snapshot?.currentPlateId ?? null };
              const object = result.objects.find(item => item.id === result.objectId)!;
              return { structure: { ok: true, objects: result.objects }, activePlateId: result.plateSession.currentPlateId,
                selection: { mode: request.entry === 'gizmo' ? 'part' : 'instance', objectIds: [result.objectId],
                  partIds: request.entry === 'gizmo' ? [result.volumeId] : [],
                  instanceIds: request.entry === 'gizmo' ? [request.instanceId] : object.instances.map(item => item.id) } };
            },
            publish: async result => {
              if (!result.ok || !result.changed) return;
              await refreshAfterModelMutation(runtime, result.plateSession);
              if (scene) {
                scene.meshBoolean.completed(result.volumeId);
                scene.meshBoolean.publishing = false;
                scene.setSelectionMode(request.entry === 'gizmo' ? 'volume' : 'instance');
                scene.selectVolumeIds(glVolumeCollection.volumes.filter(volume => volume.buffer.objectId === result.objectId &&
                  volume.buffer.volumeId === result.volumeId && (request.entry === 'object' || volume.buffer.instanceId === request.instanceId))
                  .map(volume => volume.id));
              }
            },
          });
        const result = committed.result;
        if (!result.ok) notify(result.error, 'error');
        else if (!result.changed) notify('Unable to perform boolean operation on selected parts', 'warning');
        else if (result.warning === 'positive_parts_only') notify(
          'Unable to perform boolean operation on model meshes. Only positive parts will be kept. You may fix the meshes and try again.', 'error');
        return result;
      } finally {
        if (scene) { scene.meshBoolean.publishing = false; scene.pruneSelection(); }
      }
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notify(message, 'error');
    return { ok: false, error: message };
  } finally {
    // Releasing the modal can synchronously run editor layout effects. Both
    // admission owners must have settled before those background reads resume.
    preparing = false;
    useMeshBooleanStore.setState({ busy: false });
  }
}
