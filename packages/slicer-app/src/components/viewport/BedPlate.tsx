// packages/slicer-app/src/components/viewport/BedPlate.tsx
import * as THREE from 'three';
import { Grid } from '@react-three/drei';
import { BUILD_PLATE_RAYCAST } from './buildPlatePointerOcclusion';

export const BED_SIZE = 220;
const participateInPointerRaycast = () => {};

export function BedPlate() {
  return (
    <group>
      {/* Slicer convention: Z up, X right, Y into screen — the bed is the XY
          plane at Z=0, so the plane geometry needs no rotation (it is born
          in XY) and all core coordinates pass through unmodified. */}
      <mesh
        position={[BED_SIZE / 2, BED_SIZE / 2, 0]}
        userData={{ orcaRaycastRole: BUILD_PLATE_RAYCAST }}
        // This makes the plate available to the canvas intersection filter.
        // It has no pointer behavior of its own; the filter removes it after
        // using its nearest hit to suppress occluded model-body hits.
        onPointerMove={participateInPointerRaycast}
      >
        <planeGeometry args={[BED_SIZE, BED_SIZE]} />
        <meshStandardMaterial color="#1e293b" roughness={0.9} />
      </mesh>
      {/* drei's Grid is a GROUND grid: its vertex shader swizzles to local
          XZ (position.xzy), so an unrotated grid stands vertical in the
          Z-up scene. Rx(-90°) maps the grid's local XZ onto the world XY.
          side: drei defaults to THREE.BackSide, which culls the grid from
          the default camera elevation (verified empirically: the grid only
          rendered from steep top-down angles). DoubleSide renders from
          every view above the bed. */}
      <Grid
        position={[BED_SIZE / 2, BED_SIZE / 2, 0.01]}
        rotation={[-Math.PI / 2, 0, 0]}
        args={[BED_SIZE, BED_SIZE]}
        side={THREE.DoubleSide}
        cellSize={10}
        cellThickness={0.5}
        cellColor="#334155"
        sectionSize={50}
        sectionThickness={1}
        sectionColor="#475569"
        // drei's fade is measured from the camera's projection onto the
        // grid plane. The default camera sits 283-420mm off the bed, so
        // any finite fadeDistance (500 before; drei's default is 100)
        // washes the whole grid to a fraction of its alpha from the
        // default view. For a bounded bed grid the fade only ever hides
        // the grid — never engage it.
        fadeDistance={Infinity}
        fadeStrength={1}
        infiniteGrid={false}
      />
      <axesHelper args={[30]} />
    </group>
  );
}
