// packages/slicer-app/src/components/viewport/ToolpathLines.tsx
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import type { ToolpathGeometry } from './useSliceResult';
import {
  createToolpathBandMaterial,
  updateToolpathChunkVisibility,
} from './toolpathBandGeometry';
import { buildPreviewVisibility } from './previewSemantics';

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
  const preview = useSlicerStore((s) => s.preview);
  const invalidate = useThree((s) => s.invalidate);
  const material = useMemo(() => createToolpathBandMaterial(), []);
  void cameraGestureActive;
  const visibility = useMemo(() => buildPreviewVisibility(data, {
    ...preview,
    // B2 camera gestures only change camera uniforms; keeping this input
    // explicit documents that gestures do not participate in filtering.
    visibleLayerStart: preview.visibleLayerStart,
    visibleLayerEnd: preview.visibleLayerEnd,
  }), [data, preview]);

  useEffect(() => {
    // Keep every instance in the draw call. The visibility attribute is a
    // prebuilt GPU buffer, so range/filter changes do not rebuild geometry.
    updateToolpathChunkVisibility(data.chunks, visibility);
    invalidate();
  }, [data.chunks, invalidate, visibility]);

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
