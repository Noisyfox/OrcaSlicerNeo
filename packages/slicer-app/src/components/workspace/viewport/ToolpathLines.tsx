// packages/slicer-app/src/components/viewport/ToolpathLines.tsx
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import type { ToolpathGeometry } from './useSliceResult';

export function ToolpathLines({ data }: { data: ToolpathGeometry }) {
  const ref = useRef<THREE.LineSegments>(null);
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
    <lineSegments ref={ref} geometry={data.geometry} frustumCulled={false}>
      <lineBasicMaterial vertexColors depthTest={false} transparent opacity={0.95} />
    </lineSegments>
  );
}
