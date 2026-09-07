// packages/slicer-app/src/components/viewport/useModelLoader.ts
import { useEffect, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { GLVolume, glVolumeCollection } from './GLVolume';

export type LoadedObject = GLVolume;

export function useModelLoader(): LoadedObject[] {
  const platform = usePlatform();
  const modelLoaded = useSettingsStore((s) => s.modelLoaded);
  const modelRevision = useSettingsStore((s) => s.modelRevision);
  const [objects, setObjects] = useState<LoadedObject[]>([]);

  useEffect(() => {
    let disposed = false;
    const requestedRevision = modelRevision;
    if (!modelLoaded) {
      glVolumeCollection.clear();
      setObjects([]);
      return;
    }
    (async () => {
      try {
        const res = await platform.runtime.getModelMesh();
        if (!res.ok) throw new Error(res.error ?? 'getModelMesh failed');
        const loaded: LoadedObject[] = res.objects.map((buf) => new GLVolume(buf));
        if (disposed || useSettingsStore.getState().modelRevision !== requestedRevision) {
          // The load finished after unmount/change — nothing consumes these
          // geometries; dispose them instead of leaking (review Minor 1).
          loaded.forEach((o) => o.dispose());
        } else {
          // replace() disposes the outgoing volumes, so the swap lands in one
          // render — the previous scene stays visible while the fetch is in
          // flight, instead of flashing empty on every revision bump.
          glVolumeCollection.replace(loaded, requestedRevision);
          setObjects(loaded);
        }
      } catch (err) {
        console.error('model load failed:', err);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [modelLoaded, modelRevision]);

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
