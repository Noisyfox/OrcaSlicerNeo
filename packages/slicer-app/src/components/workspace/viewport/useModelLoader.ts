// packages/slicer-app/src/components/viewport/useModelLoader.ts
import { useEffect, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { GLVolume, glVolumeCollection, rejectGLVolumeRevision } from './GLVolume';
import { projectFullModelMesh } from './modelMeshProjection';

export type LoadedObject = GLVolume;

export function useModelLoader(): LoadedObject[] {
  const platform = usePlatform();
  const modelLoaded = useSettingsStore((s) => s.modelLoaded);
  const modelRevision = useSettingsStore((s) => s.modelRevision);
  const [objects, setObjects] = useState<LoadedObject[]>([]);

  useEffect(() => glVolumeCollection.subscribe((volumes) => setObjects([...volumes])), []);

  useEffect(() => {
    let disposed = false;
    const requestedRevision = modelRevision;
    if (!modelLoaded) {
      glVolumeCollection.clear(requestedRevision);
      setObjects([]);
      return;
    }
    (async () => {
      const loaded: LoadedObject[] = [];
      try {
        const res = await platform.runtime.getModelMesh();
        loaded.push(...projectFullModelMesh(res));
        if (disposed || useSettingsStore.getState().modelRevision !== requestedRevision) {
          // The load finished after unmount/change — nothing consumes these
          // geometries; dispose them instead of leaking (review Minor 1).
          loaded.forEach((o) => o.dispose());
        } else {
          // replace() disposes the outgoing volumes, so the swap lands in one
          // render — the previous scene stays visible while the fetch is in
          // flight, instead of flashing empty on every revision bump.
          glVolumeCollection.replace(loaded, requestedRevision);
          const env = import.meta.env as { MODE?: string; VITE_E2E?: string };
          if (env.MODE === 'e2e' || env.VITE_E2E === '1') {
            const w = window as unknown as { __orcaE2e?: Record<string, unknown> };
            w.__orcaE2e = {
              ...w.__orcaE2e,
              modelMeshResponse: () => ({
                objects: res.objects.map((object) => ({
                  volumeId: object.volumeId, objectId: object.objectId, instanceId: object.instanceId,
                  geometryKey: object.geometryKey, paintGeometryKey: object.paintGeometryKey,
                })),
                paintGeometries: res.paintGeometries.map((paint) => ({
                  volumeId: paint.volumeId, paintGeometryKey: paint.paintGeometryKey,
                  indexCount: paint.indexCount, drawGroups: paint.drawGroups,
                })),
              }),
              previewFirstCommitPaintMaterialsByVolume: {},
            };
          }
        }
      } catch (err) {
        loaded.forEach((volume) => volume.dispose());
        if (!disposed && useSettingsStore.getState().modelRevision === requestedRevision)
          rejectGLVolumeRevision(requestedRevision, err);
        console.error('model load failed:', err);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [modelRevision]);

  // Real unmount (Canvas teardown) disposes the mounted geometries. Kept
  // separate from the revision effect above so a reload — e.g. adding a
  // second model — never blanks the scene.
  useEffect(() => {
    return () => {
      setObjects((prev) => {
        prev.forEach((o) => o.dispose());
        return [];
      });
    };
  }, []);

  return objects;
}
