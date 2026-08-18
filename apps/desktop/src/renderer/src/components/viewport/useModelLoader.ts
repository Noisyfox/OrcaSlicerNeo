// apps/desktop/src/renderer/src/components/viewport/useModelLoader.ts
import { useEffect, useState } from 'react';
import { slicerClient } from '../../slicer/slicerClient';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { computeObjectMinZ, buildTransformSeeds } from './transformMath';
import { GLVolume, glVolumeCollection } from './GLVolume';

export type LoadedObject = GLVolume;

export function useModelLoader(): LoadedObject[] {
  const modelLoaded = useSettingsStore((s) => s.modelLoaded);
  const [objects, setObjects] = useState<LoadedObject[]>([]);

  useEffect(() => {
    let disposed = false;
    if (!modelLoaded) {
      useSettingsStore.getState().setObjectOffsets({}, {}, {});
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
          // Seed the move state: current offsets, the reset snapshot, and the
          // per-object bed-contact min Z (Drop to bed).
          const seeds = buildTransformSeeds(
            loaded.map((o) => ({
              objectIdx: o.buffer.objectIdx,
              offset: o.buffer.offset as [number, number, number],
              minZ: computeObjectMinZ(o.geometry),
            })),
          );
          useSettingsStore.getState().setObjectOffsets(seeds.positions, seeds.initialPositions, seeds.objectMinZ);
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
  }, [modelLoaded]);

  return objects;
}
