// packages/slicer-app/src/components/viewport/useModelLoader.ts
import { useEffect, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { GLVolume, glVolumeCollection, rejectGLVolumeRevision } from './GLVolume';

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
        if (!res.ok) throw new Error(res.error ?? 'getModelMesh failed');
        for (const buffer of res.objects)
          loaded.push(new GLVolume(buffer, { kind: 'shared', key: buffer.geometryKey }));
        if (disposed || useSettingsStore.getState().modelRevision !== requestedRevision) {
          // The load finished after unmount/change — nothing consumes these
          // geometries; dispose them instead of leaking (review Minor 1).
          loaded.forEach((o) => o.dispose());
        } else {
          // replace() disposes the outgoing volumes, so the swap lands in one
          // render — the previous scene stays visible while the fetch is in
          // flight, instead of flashing empty on every revision bump.
          glVolumeCollection.replace(loaded, requestedRevision);
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
