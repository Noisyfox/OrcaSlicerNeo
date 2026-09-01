// packages/slicer-app/src/components/viewport/ToolpathLines.tsx
import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import type { ToolpathGeometry } from './useSliceResult';
import {
  createToolpathBandMaterial,
  selectToolpathChunks,
} from './toolpathBandGeometry';

/**
 * GPU toolpath renderer. Each segment is an instanced rectangular prism whose
 * width/height are world-space attributes. OrbitControls only changes the
 * camera uniforms consumed by the shader; the chunk geometries are created
 * once per slice result and remain resident until that result is invalidated.
 */
export function ToolpathLines({
  data,
  cameraGestureActive = false,
}: {
  data: ToolpathGeometry;
  cameraGestureActive?: boolean;
}) {
  const layer = useSlicerStore((s) => s.layer);
  const invalidate = useThree((s) => s.invalidate);
  const material = useMemo(() => createToolpathBandMaterial(), []);
  const visibleChunks = useMemo(() => selectToolpathChunks(
    data.chunks,
    layer,
    layer,
    data.segmentCount,
    cameraGestureActive,
  ), [cameraGestureActive, data.chunks, data.segmentCount, layer]);

  useEffect(() => {
    const selected = new Set(visibleChunks);
    data.chunks.forEach((chunk, index) => {
      // Keep the existing single-layer scrubber behavior until B3 replaces it
      // with the inclusive dual-thumb range. Adaptive camera mode expands the
      // active layer to nearby chunks only for large streams.
      chunk.geometry.instanceCount = selected.has(index)
        ? chunk.segmentCount
        : 0;
    });
    invalidate();
  }, [data.chunks, invalidate, layer, visibleChunks]);

  useEffect(() => () => material.dispose(), [material]);

  return (
    <group renderOrder={1000}>
      {data.chunks.map((chunk) => (
        <mesh
          key={`${chunk.firstSegment}:${chunk.segmentCount}`}
          geometry={chunk.geometry}
          material={material}
          frustumCulled={false}
          renderOrder={1000}
        />
      ))}
    </group>
  );
}
