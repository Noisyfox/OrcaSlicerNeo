import * as THREE from 'three';
import type { PaintingState } from './PaintingController';

declare const __ORCA_E2E__: boolean;

export const PAINTING_RENDER_ORDER = { draft: 0, candidate: 2, contour: 3, cursor: 4 } as const;

/** All cursors use the final transparent pass, even opaque overlays. Group and
 * draw-object order both matter to Three's sorting; no cursor writes depth. */
export function PaintingCursor({ tool, settings, position, cameraQuaternion, bounds, color }: {
  tool: PaintingState['tool']; settings: PaintingState['settings']; position: THREE.Vector3;
  cameraQuaternion: THREE.Quaternion; bounds: THREE.Box3; color: THREE.Color;
}) {
  if (tool === 'gap' || tool === 'region') return null;
  const sphere = tool === 'sphere', height = tool === 'height';
  const size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
  return <group position={position} renderOrder={PAINTING_RENDER_ORDER.cursor}>
    <mesh renderOrder={PAINTING_RENDER_ORDER.cursor} name={__ORCA_E2E__ ? `painting-cursor-${tool}` : undefined}
      quaternion={tool === 'circle' ? cameraQuaternion : undefined}
      position={height ? [center.x - position.x, center.y - position.y, settings.height / 2] : undefined}>
      {sphere ? <sphereGeometry args={[settings.radius, 24, 16]} />
        : tool === 'circle' ? <ringGeometry args={[settings.radius * 0.97, settings.radius, 64]} />
          : height ? <boxGeometry args={[size.x, size.y, settings.height]} />
            : <sphereGeometry args={[0.4, 8, 8]} />}
      <meshBasicMaterial color={color} transparent opacity={sphere ? 0.25 : 1}
        side={tool === 'circle' ? THREE.DoubleSide : THREE.FrontSide}
        wireframe={height} depthTest={sphere} depthWrite={false} />
    </mesh>
  </group>;
}
