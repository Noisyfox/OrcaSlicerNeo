// apps/desktop/src/renderer/src/components/viewport/Scene.tsx
import { useModelLoader } from './useModelLoader';
import { BedPlate } from './BedPlate';
import { ModelMesh } from './ModelMesh';
import { useSliceResult } from './useSliceResult';
import { ToolpathLines } from './ToolpathLines';
import { SlicedMesh } from './SlicedMesh';

export function Scene() {
  const objects = useModelLoader();
  const { toolpath, mesh } = useSliceResult();
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
