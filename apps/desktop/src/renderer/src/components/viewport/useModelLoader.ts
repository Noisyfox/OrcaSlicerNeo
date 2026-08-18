// apps/desktop/src/renderer/src/components/viewport/useModelLoader.ts
import { useEffect, useState } from 'react';
import { slicerClient } from '../../slicer/slicerClient';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { GLVolume, glVolumeCollection } from './GLVolume';

export type LoadedObject = GLVolume;

export function useModelLoader(): LoadedObject[] {
  const modelLoaded = useSettingsStore((s) => s.modelLoaded);
  const modelRevision = useSettingsStore((s) => s.modelRevision);
  const [objects, setObjects] = useState<LoadedObject[]>([]);

  useEffect(() => {
    let disposed = false;
    if (!modelLoaded) {
      glVolumeCollection.clear();
      setObjects([]);
      return;
    }
    (async () => {
      try {
        const res = await slicerClient.getModelMesh();
        if (!res.ok) throw new Error(res.error ?? 'getModelMesh failed');
        const loaded: LoadedObject[] = res.objects.map((buf) => new GLVolume(buf));
        if (disposed) {
          // The load finished after unmount/change — nothing consumes these
          // geometries; dispose them instead of leaking (review Minor 1).
          loaded.forEach((o) => o.dispose());
        } else {
          glVolumeCollection.replace(loaded);
          setObjects(loaded);
        }
      } catch (err) {
        console.error('model load failed:', err);
      }
    })();
    return () => {
      disposed = true;
      // dispose geometries on unmount
      setObjects((prev) => {
        prev.forEach((o) => o.dispose());
        return [];
      });
    };
  }, [modelLoaded, modelRevision]);

  return objects;
}
