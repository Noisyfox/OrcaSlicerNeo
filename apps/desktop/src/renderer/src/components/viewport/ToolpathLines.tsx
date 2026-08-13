// apps/desktop/src/renderer/src/components/viewport/ToolpathLines.tsx
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useSlicerStore } from '../../stores/useSlicerStore';
import type { ToolpathGeometry } from './useSliceResult';

export function ToolpathLines({ data }: { data: ToolpathGeometry }) {
  const ref = useRef<THREE.LineSegments>(null);
  const layer = useSlicerStore((s) => s.layer);

  useEffect(() => {
    const range = data.layerRanges[layer] ?? [0, 0];
    data.geometry.setDrawRange(range[0], range[1]);
  }, [data, layer]);

  return (
    <lineSegments ref={ref} geometry={data.geometry} frustumCulled={false}>
      <lineBasicMaterial vertexColors depthTest={false} transparent opacity={0.95} />
    </lineSegments>
  );
}
