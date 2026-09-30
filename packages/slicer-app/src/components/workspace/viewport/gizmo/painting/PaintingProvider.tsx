import { createContext, useContext, useRef, useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react';
import { coordinatePaintingRpc } from '../../../actions/historyMutation';
import { registerPaintingCommands } from './projectCommands';
import { usePlatform } from '@orca/platform-contract';
import { PaintingController } from './PaintingController';
import { projectHistoryStatus } from '../../../../../history/projectHistoryStatus';
import { invalidateAffectedPlateResults } from '../../../../../stores/plateResultLifecycle';
import { useSettingsStore } from '../../../../../stores/useSettingsStore';
import { useFilamentSessionStore } from '../../../../../stores/useFilamentSessionStore';
import { glVolumeCollection } from '../../GLVolume';
import { readSceneDeltaProjection } from '../../sceneDeltaProjection';
import type { SceneInteractionController } from '../../SceneInteractionController';
import { useObjectListStore } from '../../../objectList/useObjectListStore';
import type { SlicerClient } from '@slicer/client';

/** The caller owns the painting/project lane through this atomic publication. */
export async function preparePaintingClosedScene(runtime: Pick<SlicerClient, 'getModelScenePatch'>, paintedObjectIds: readonly number[]) {
  // Project/history commands already publish their own SceneDelta. Only
  // strokes leave committed paint absent from Prepare; an untouched session
  // can return to its existing complete projection without a native read.
  if (!paintedObjectIds.length) return;
  const structure = useObjectListStore.getState().structure;
  const projection = await readSceneDeltaProjection(runtime, {
    version: 1, objectIds: paintedObjectIds, objectOrder: structure.map((o) => o.id),
    volumeIds: [], instanceIds: [], plateIds: [],
  }, structure, glVolumeCollection.volumes);
  projection.apply();
  glVolumeCollection.patch(projection.volumes, useSettingsStore.getState().modelRevision);
}

const Context = createContext<PaintingController | null>(null);
/** App-owned: removing or hiding a viewport does not close native history. */
export function PaintingProvider({ children }: { children: ReactNode }) {
  const { runtime } = usePlatform();
  const owner = useRef<PaintingController | null>(null);
  if (!owner.current) owner.current = new PaintingController({
    coordinate: coordinatePaintingRpc,
    palette: () => useFilamentSessionStore.getState().snapshot,
    targetAvailable: (objectId, instanceId) => useObjectListStore.getState().structure
      .some((object) => object.id === objectId && object.instances.some((instance) => instance.id === instanceId)),
    api: runtime,
    history: projectHistoryStatus,
    committed: (plates) => invalidateAffectedPlateResults(runtime, plates),
    prepareClosed: (paintedObjectIds) => preparePaintingClosedScene(runtime, paintedObjectIds),
    schedule: (callback) => { const id = requestAnimationFrame(callback); return () => cancelAnimationFrame(id); },
  });
  useLayoutEffect(() => registerPaintingCommands(owner.current!), []);
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
