import * as THREE from 'three';
import { useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import type { PaintingState } from './PaintingController';
import { HeightRangeCursor } from './HeightRangeCursor';

declare const __ORCA_E2E__: boolean;

export const PAINTING_RENDER_ORDER = { draft: 0, candidate: 2, contour: 3, cursor: 4 } as const;
export const CIRCLE_CURSOR_LINE_WIDTH_PX = 2;

/** Orca core-profile render_cursor_circle samples alternating angular intervals.
 * Its camera zoom is pixels/mm and is capped at 250. */
export function circleCursorSteps(zoom: number): number {
  return 2 * (4 + Math.trunc(252 * (Math.max(0, Math.min(250, zoom)) - 1) / 249));
}

function CircleCursor({ radius, position, cameraQuaternion, color }: {
  radius: number; position: THREE.Vector3; cameraQuaternion: THREE.Quaternion; color: THREE.Color;
}) {
  const { camera, size } = useThree();
  const clip = new THREE.Vector4(position.x, position.y, position.z, 1)
    .applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
  const steps = circleCursorSteps(size.height * Math.abs(camera.projectionMatrix.elements[5]) / (2 * clip.w));
  const points = useMemo(() => Array.from({ length: steps }, (_, i): [number, number, number] => {
    const angle = i * 2 * Math.PI / steps;
    return [Math.cos(angle), Math.sin(angle), 0];
  }), [steps]);
  return <Line segments points={points} scale={radius} quaternion={cameraQuaternion}
    lineWidth={CIRCLE_CURSOR_LINE_WIDTH_PX} worldUnits={false}
    color={color} transparent opacity={1} side={THREE.DoubleSide} forceSinglePass
    depthTest={false} depthWrite={false} renderOrder={PAINTING_RENDER_ORDER.cursor}
    name={__ORCA_E2E__ ? 'painting-cursor-circle' : undefined} />;
}

/** All cursors use the final transparent pass, even opaque overlays. Group and
 * draw-object order both matter to Three's sorting; no cursor writes depth. */
export function PaintingCursor({ tool, settings, position, cameraQuaternion, bounds, color, meshes }: {
  tool: PaintingState['tool']; settings: PaintingState['settings']; position: THREE.Vector3;
  cameraQuaternion: THREE.Quaternion; bounds: THREE.Box3; color: THREE.Color;
  meshes: readonly THREE.Mesh[];
}) {
  if (tool === 'triangle' || tool === 'gap' || tool === 'region') return null;
  if (tool === 'height') return <HeightRangeCursor meshes={meshes} bounds={bounds} hitZ={position.z} height={settings.height} renderOrder={PAINTING_RENDER_ORDER.cursor} />;
  return <group position={position} renderOrder={PAINTING_RENDER_ORDER.cursor}>
    {tool === 'circle' ? <CircleCursor radius={settings.radius} position={position} cameraQuaternion={cameraQuaternion} color={color} />
    : <mesh renderOrder={PAINTING_RENDER_ORDER.cursor} name={__ORCA_E2E__ ? 'painting-cursor-sphere' : undefined}>
      <sphereGeometry args={[settings.radius, 24, 16]} />
      <meshBasicMaterial color={color} transparent opacity={0.25}
        side={THREE.FrontSide} depthTest depthWrite={false} />
    </mesh>}
  </group>;
}
