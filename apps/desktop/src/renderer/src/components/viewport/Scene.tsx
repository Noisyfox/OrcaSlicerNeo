// apps/desktop/src/renderer/src/components/viewport/Scene.tsx
import { useModelLoader } from './useModelLoader';
import { BedPlate } from './BedPlate';
import { ModelMesh } from './ModelMesh';

export function Scene() {
  const objects = useModelLoader();
  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[100, 200, 150]} intensity={1.2} />
      <BedPlate />
      {objects.map((o) => (
        <ModelMesh key={o.buffer.objectIdx} data={o} />
      ))}
    </>
  );
}
