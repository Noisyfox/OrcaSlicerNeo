// apps/desktop/src/renderer/src/components/viewport/BedPlate.tsx
import * as THREE from 'three';
import { Grid } from '@react-three/drei';

export const BED_SIZE = 220;

export function BedPlate() {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[BED_SIZE / 2, 0, BED_SIZE / 2]}>
        <planeGeometry args={[BED_SIZE, BED_SIZE]} />
        <meshStandardMaterial color="#1e293b" roughness={0.9} />
      </mesh>
      <Grid
        position={[BED_SIZE / 2, 0.01, BED_SIZE / 2]}
        args={[BED_SIZE, BED_SIZE]}
        cellSize={10}
        cellThickness={0.5}
        cellColor="#334155"
        sectionSize={50}
        sectionThickness={1}
        sectionColor="#475569"
        fadeDistance={500}
        fadeStrength={1}
        infiniteGrid={false}
      />
      <axesHelper args={[30]} />
    </group>
  );
}
