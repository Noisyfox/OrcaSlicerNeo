// apps/desktop/src/renderer/src/components/viewport/useModelLoader.ts
import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { slicerClient } from '../../slicer/slicerClient';
import { useSettingsStore } from '../../stores/useSettingsStore';
import type { ModelObjectBuffer } from '@slicer/client';

export interface LoadedObject {
  buffer: ModelObjectBuffer;
  geometry: THREE.BufferGeometry;
}

export function useModelLoader(): LoadedObject[] {
  const modelLoaded = useSettingsStore((s) => s.modelLoaded);
  const [objects, setObjects] = useState<LoadedObject[]>([]);

  useEffect(() => {
    let disposed = false;
    if (!modelLoaded) {
      setObjects([]);
      return;
    }
    (async () => {
      try {
        const res = await slicerClient.getModelMesh();
        if (!res.ok) throw new Error(res.error ?? 'getModelMesh failed');
        const loaded: LoadedObject[] = res.objects.map((buf) => {
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.BufferAttribute(buf.positions, 3));
          geometry.setIndex(new THREE.BufferAttribute(buf.indices, 1));
          geometry.computeVertexNormals();
          return { buffer: buf, geometry };
        });
        if (!disposed) setObjects(loaded);
      } catch (err) {
        console.error('model load failed:', err);
      }
    })();
    return () => {
      disposed = true;
      // dispose geometries on unmount
      setObjects((prev) => {
        prev.forEach((o) => o.geometry.dispose());
        return [];
      });
    };
  }, [modelLoaded]);

  return objects;
}
