import * as THREE from 'three';
import { Line } from '@react-three/drei';
import type { PaintingState } from './PaintingController';
import { HeightRangeCursor } from './HeightRangeCursor';

declare const __ORCA_E2E__: boolean;

export const PAINTING_RENDER_ORDER = { draft: 0, candidate: 2, contour: 3, cursor: 4 } as const;
export const CIRCLE_CURSOR_LINE_WIDTH_PX = 2;

const CIRCLE_CURSOR_POINTS = Array.from({ length: 65 }, (_, i): [number, number, number] => {
  const angle = i * Math.PI / 32;
  return [Math.cos(angle), Math.sin(angle), 0];
});

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
    {tool === 'circle' ? <Line
      points={CIRCLE_CURSOR_POINTS} scale={settings.radius} quaternion={cameraQuaternion}
      lineWidth={CIRCLE_CURSOR_LINE_WIDTH_PX} worldUnits={false}
      color={color} transparent opacity={1} side={THREE.DoubleSide} forceSinglePass
      depthTest={false} depthWrite={false} renderOrder={PAINTING_RENDER_ORDER.cursor}
      name={__ORCA_E2E__ ? 'painting-cursor-circle' : undefined}
    /> : <mesh renderOrder={PAINTING_RENDER_ORDER.cursor} name={__ORCA_E2E__ ? 'painting-cursor-sphere' : undefined}>
      <sphereGeometry args={[settings.radius, 24, 16]} />
      <meshBasicMaterial color={color} transparent opacity={0.25}
        side={THREE.FrontSide} depthTest depthWrite={false} />
    </mesh>}
  </group>;
}
