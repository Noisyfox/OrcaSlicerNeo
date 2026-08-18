// apps/desktop/src/renderer/src/components/viewport/SlicedMesh.tsx
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { useSlicerStore } from '../../stores/useSlicerStore';
import type { SlicedMeshGeometry } from './useSliceResult';

export function SlicedMesh({
  data,
  position,
}: {
  data: SlicedMeshGeometry;
  position: [number, number, number];
}) {
  const ref = useRef<THREE.Mesh>(null);
  const layer = useSlicerStore((s) => s.layer);
  // setDrawRange mutates the geometry imperatively — invisible to the r3f
  // reconciler, so demand mode needs an explicit invalidate to redraw.
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    const range = data.layerRanges[layer] ?? [0, 0];
    data.geometry.setDrawRange(range[0], range[1]);
    invalidate();
  }, [data, layer, invalidate]);

  return (
    <group position={position}>
      <mesh ref={ref} geometry={data.geometry} frustumCulled={false}>
        <meshBasicMaterial color="#94a3b8" wireframe transparent opacity={0.35} depthWrite={false} />
      </mesh>
    </group>
  );
}
