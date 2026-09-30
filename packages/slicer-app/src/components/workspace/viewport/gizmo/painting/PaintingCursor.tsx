import * as THREE from 'three';
import type { PaintingState } from './PaintingController';
import { HeightRangeCursor } from './HeightRangeCursor';

declare const __ORCA_E2E__: boolean;

export const PAINTING_RENDER_ORDER = { draft: 0, candidate: 2, contour: 3, cursor: 4 } as const;

/** All cursors use the final transparent pass, even opaque overlays. Group and
 * draw-object order both matter to Three's sorting; no cursor writes depth. */
export function PaintingCursor({ tool, settings, position, cameraQuaternion, bounds, color, meshes }: {
  tool: PaintingState['tool']; settings: PaintingState['settings']; position: THREE.Vector3;
  cameraQuaternion: THREE.Quaternion; bounds: THREE.Box3; color: THREE.Color;
  meshes: readonly THREE.Mesh[];
}) {
  if (tool === 'triangle' || tool === 'gap' || tool === 'region') return null;
  if (tool === 'height') return <HeightRangeCursor meshes={meshes} bounds={bounds} hitZ={position.z} height={settings.height} renderOrder={PAINTING_RENDER_ORDER.cursor} />;
  const sphere = tool === 'sphere';
  return <group position={position} renderOrder={PAINTING_RENDER_ORDER.cursor}>
    <mesh renderOrder={PAINTING_RENDER_ORDER.cursor} name={__ORCA_E2E__ ? `painting-cursor-${tool}` : undefined}
      quaternion={tool === 'circle' ? cameraQuaternion : undefined}>
      {sphere ? <sphereGeometry args={[settings.radius, 24, 16]} />
        : <ringGeometry args={[settings.radius * 0.97, settings.radius, 64]} />}
      <meshBasicMaterial color={color} transparent opacity={sphere ? 0.25 : 1}
        side={tool === 'circle' ? THREE.DoubleSide : THREE.FrontSide}
        depthTest={sphere} depthWrite={false} />
    </mesh>
  </group>;
}
