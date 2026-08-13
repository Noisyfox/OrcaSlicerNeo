// apps/desktop/src/renderer/src/components/viewport/SlicedMesh.tsx
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useSlicerStore } from '../../stores/useSlicerStore';
import type { SlicedMeshGeometry } from './useSliceResult';

export function SlicedMesh({ data }: { data: SlicedMeshGeometry }) {
  const ref = useRef<THREE.Mesh>(null);
  const layer = useSlicerStore((s) => s.layer);

  useEffect(() => {
    const range = data.layerRanges[layer] ?? [0, 0];
    data.geometry.setDrawRange(range[0], range[1]);
  }, [data, layer]);

  return (
    <mesh ref={ref} geometry={data.geometry} frustumCulled={false}>
      <meshBasicMaterial color="#94a3b8" wireframe transparent opacity={0.35} depthWrite={false} />
    </mesh>
  );
}
