import { createContext, useContext, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { PaintingController } from './PaintingController';
import { projectHistoryStatus } from '../../../../../history/projectHistoryStatus';
import { invalidateAffectedPlateResults } from '../../../../../stores/plateResultLifecycle';
import { useSettingsStore } from '../../../../../stores/useSettingsStore';
import { glVolumeCollection } from '../../GLVolume';
import { projectFullModelMesh } from '../../modelMeshProjection';
import type { SceneInteractionController } from '../../SceneInteractionController';
import { useObjectListStore } from '../../../objectList/useObjectListStore';

const Context = createContext<PaintingController | null>(null);
/** App-owned: removing or hiding a viewport does not close native history. */
export function PaintingProvider({ children }: { children: ReactNode }) {
  const { runtime } = usePlatform();
  const owner = useRef<PaintingController | null>(null);
  if (!owner.current) owner.current = new PaintingController({
    api: runtime,
    history: projectHistoryStatus,
    committed: (plates) => invalidateAffectedPlateResults(runtime, plates),
    prepareClosed: async () => {
      const mesh = await runtime.getModelMesh();
      const volumes = projectFullModelMesh(mesh);
      glVolumeCollection.replace(volumes, useSettingsStore.getState().modelRevision);
    },
    schedule: (callback) => { const id = requestAnimationFrame(callback); return () => cancelAnimationFrame(id); },
  });
  return <Context.Provider value={owner.current}>{children}</Context.Provider>;
}
export function usePaintingController(): PaintingController | null { return useContext(Context); }
export function usePaintingPhase() {
  const controller = usePaintingController();
  return useSyncExternalStore(controller?.subscribe ?? noSubscribe, () => controller?.getSnapshot().phase ?? 'closed');
}
export function usePaintingState() {
  const controller = usePaintingController();
  return useSyncExternalStore(controller?.subscribe ?? noSubscribe, controller?.getSnapshot ?? noSnapshot);
}
const noSubscribe = () => () => {};
const noSnapshot = () => null;

export function paintingTarget(scene: SceneInteractionController): { objectId: number; instanceId: number } | null {
  if (scene.hasWipeTowerSelection) return null;
  const selected = scene.selectedVolumes();
  if (!selected.length) return null;
  const first = selected[0].buffer;
  if (selected.some((v) => v.buffer.objectId !== first.objectId || v.buffer.instanceId !== first.instanceId)) return null;
  const object = useObjectListStore.getState().structure.find((o) => o.id === first.objectId);
  if (!object?.volumes.some((v) => v.type === 'model_part')) return null;
  return { objectId: first.objectId, instanceId: first.instanceId };
}
