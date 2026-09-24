// packages/slicer-app/src/components/viewport/BedPlate.tsx
import * as THREE from 'three';
import { useMemo } from 'react';
import { Grid } from '@react-three/drei';
import { BUILD_PLATE_RAYCAST } from './buildPlatePointerOcclusion';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import type { PlateSessionPlate } from '@slicer/client';

export const BED_SIZE = 220;
export const DEFAULT_PRINTABLE_AREA: Array<[number, number]> = [
  [0, 0], [BED_SIZE, 0], [BED_SIZE, BED_SIZE], [0, BED_SIZE],
];

export interface PrintableAreaBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  depth: number;
  centerX: number;
  centerY: number;
}

export function normalizePrintableArea(points: unknown): Array<[number, number]> {
  if (!Array.isArray(points) || points.length < 3 || points.some((point) => (
    !Array.isArray(point)
      || point.length < 2
      || typeof point[0] !== 'number'
      || typeof point[1] !== 'number'
      || !Number.isFinite(point[0])
      || !Number.isFinite(point[1])
  ))) {
    return DEFAULT_PRINTABLE_AREA;
  }
  return points as Array<[number, number]>;
}

export function getPrintableAreaBounds(points: Array<[number, number]>): PrintableAreaBounds {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    minX, minY, maxX, maxY,
    width: Math.max(maxX - minX, 1),
    depth: Math.max(maxY - minY, 1),
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

const participateInPointerRaycast = () => {};
const GROUND_Z = -0.04;
const GROUND_Z_GRID = -0.26;
const GROUND_Z_BED = -0.41 + GROUND_Z;

export interface BedPlateProps {
  plate?: PlateSessionPlate;
  current?: boolean;
  onEmptyBedClick?: (plateId: string) => void;
}

export function BedPlate({ plate, current = false, onEmptyBedClick }: BedPlateProps = {}) {
  const printableArea = useSettingsStore((state) => state.printableArea);
  const area = useMemo(() => normalizePrintableArea(printableArea), [printableArea]);
  const bounds = useMemo(() => getPrintableAreaBounds(area), [area]);
  const shape = useMemo(() => {
    const value = new THREE.Shape();
    area.forEach(([x, y], index) => {
      if (index === 0) value.moveTo(x, y);
      else value.lineTo(x, y);
    });
    value.closePath();
    return value;
  }, [area]);

  const plateOrigin = plate?.origin ?? [0, 0, 0] as const;
  const outOfBounds = Boolean(plate && plate.valid === false);
  return (
    <group>
      {/* Slicer convention: Z up, X right, Y into screen — the bed is the XY
          plane at Z=0, so the plane geometry needs no rotation (it is born
          in XY) and all core coordinates pass through unmodified. */}
      <mesh
        position={[plateOrigin[0], plateOrigin[1], plateOrigin[2] + GROUND_Z_BED]}
        userData={{
          orcaRaycastRole: BUILD_PLATE_RAYCAST,
          plateId: plate?.plateId,
          plateCurrent: current,
          plateOutOfBounds: outOfBounds,
          plateName: plate?.name,
        }}
        // This makes the plate available to the canvas intersection filter.
        // It has no pointer behavior of its own; the filter removes it after
        // using its nearest hit to suppress occluded model-body hits.
        onPointerMove={participateInPointerRaycast}
        onClick={plate?.plateId ? (event) => {
          event.stopPropagation();
          onEmptyBedClick?.(plate.plateId);
        } : undefined}
      >
        <shapeGeometry args={[shape]} />
        <meshStandardMaterial
          color={outOfBounds ? '#BB2A3A' : current ? '#34343A' : '#626269'}
          roughness={1}
        />
      </mesh>
      {/* drei's Grid is a GROUND grid: its vertex shader swizzles to local
          XZ (position.xzy), so an unrotated grid stands vertical in the
          Z-up scene. Rx(-90°) maps the grid's local XZ onto the world XY.
          side: drei defaults to THREE.BackSide, which culls the grid from
          the default camera elevation (verified empirically: the grid only
          rendered from steep top-down angles). DoubleSide renders from
          every view above the bed. */}
      <Grid
        position={[plateOrigin[0] + bounds.centerX, plateOrigin[1] + bounds.centerY, plateOrigin[2] + GROUND_Z_GRID]}
        rotation={[-Math.PI / 2, 0, 0]}
        args={[bounds.width, bounds.depth]}
        side={THREE.DoubleSide}
        cellSize={10}
        cellThickness={0.5}
        cellColor="#3E3E45"
        sectionSize={50}
        sectionThickness={1}
        sectionColor="#4C4C55"
        // drei's fade is measured from the camera's projection onto the
        // grid plane. The default camera sits ~320-545mm off the bed (see
        // DEFAULT_CAMERA_POSITION in Viewport.tsx), so any finite
        // fadeDistance (500 before; drei's default is 100) washes the whole
        // grid to a fraction of its alpha from the default view. For a
        // bounded bed grid the fade only ever hides the grid — never engage
        // it.
        fadeDistance={Infinity}
        fadeStrength={1}
        infiniteGrid={false}
      />
      {plate?.plateId && <axesHelper args={[30]} position={plateOrigin} />}
    </group>
  );
}
