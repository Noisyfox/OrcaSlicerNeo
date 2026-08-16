// apps/desktop/src/renderer/src/components/viewport/Scene.tsx
import { useEffect } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { useModelLoader } from './useModelLoader';
import { BedPlate } from './BedPlate';
import { ModelMesh } from './ModelMesh';
import { useSliceResult } from './useSliceResult';
import { ToolpathLines } from './ToolpathLines';
import { SlicedMesh } from './SlicedMesh';

export function Scene() {
  const objects = useModelLoader();
  const { toolpath, mesh } = useSliceResult();
  // Test-only projection hook (mock/e2e builds): Playwright needs exact
  // canvas coordinates to start an axis-arrow drag on the gizmo's shaft.
  // No-op in production builds (VITE_USE_MOCK is unset).
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  useEffect(() => {
    if (!(import.meta.env as { VITE_USE_MOCK?: string }).VITE_USE_MOCK) return;
    const w = window as unknown as {
      __orcaE2e?: { projectWorldToScreen(p: [number, number, number]): { x: number; y: number } | null };
    };
    w.__orcaE2e = {
      projectWorldToScreen(p) {
        const v = new THREE.Vector3(p[0], p[1], p[2]).project(camera);
        return { x: (v.x + 1) * 0.5 * size.width, y: (1 - v.y) * 0.5 * size.height };
      },
    };
    return () => { delete w.__orcaE2e; };
  }, [camera, size]);

  return (
    <>
      <ambientLight intensity={0.6} />
      {/* height along Z — scene is Z-up slicer convention */}
      <directionalLight position={[100, 150, 200]} intensity={1.2} />
      <BedPlate />
      {objects.map((o) => (
        <ModelMesh key={o.buffer.objectIdx} data={o} />
      ))}
      {mesh && <SlicedMesh data={mesh} />}
      {toolpath && <ToolpathLines data={toolpath} />}
    </>
  );
}
