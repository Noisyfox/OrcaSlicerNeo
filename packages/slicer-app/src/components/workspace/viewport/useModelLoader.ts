// packages/slicer-app/src/components/viewport/useModelLoader.ts
import { useEffect, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { GLVolume, glVolumeCollection, rejectGLVolumeRevision } from './GLVolume';
import { projectFullModelMesh } from './modelMeshProjection';
import { recordModelMeshResponse, registerModelLoadingProbeOwner } from '../../../e2e/modelLoadingProbe';

declare const __ORCA_E2E__: boolean;

export type LoadedObject = GLVolume;

export function useModelLoader(): LoadedObject[] {
  const platform = usePlatform();
  const modelLoaded = useSettingsStore((s) => s.modelLoaded);
  const modelRevision = useSettingsStore((s) => s.modelRevision);
  const [objects, setObjects] = useState<LoadedObject[]>([]);

  useEffect(() => {
    if (!__ORCA_E2E__) return;
    return registerModelLoadingProbeOwner();
  }, []);

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
          if (__ORCA_E2E__) recordModelMeshResponse(res);
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
