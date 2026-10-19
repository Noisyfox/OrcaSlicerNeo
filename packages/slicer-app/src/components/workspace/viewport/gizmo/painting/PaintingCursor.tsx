import * as THREE from 'three';
import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import type { PaintingState } from './PaintingController';
import type { MeshBVH } from 'three-mesh-bvh';

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

export function heightRangePlanes(bounds: THREE.Box3, hitZ: number, height: number): readonly [number, number] {
  // Orca stores cursor_z, min/max Z and the height addition as floats. A ray
  // hit infinitesimally below a cap must become the end plane, not a hairline
  // interior section caused by JavaScript's double precision.
  const min = Math.fround(bounds.min.z), max = Math.fround(bounds.max.z);
  const lower = THREE.MathUtils.clamp(Math.fround(hitZ), min, max);
  return [lower, THREE.MathUtils.clamp(Math.fround(lower + Math.fround(height)), min, max)];
}

/** Visual sections only. Borrow the immutable original BVH, never the native
 * selector's subdivided draft. Transform the plane for BVH pruning and vertices
 * for intersections so world Z survives rotation, reflection and scale. */
export function heightRangeContours(meshes: readonly THREE.Mesh[], bounds: THREE.Box3, planes: readonly [number, number]): THREE.BufferGeometry {
  const positions: number[] = [];
  const epsilon = Math.max(1, bounds.getSize(new THREE.Vector3()).length()) * 1e-9;
  const vertex = new THREE.Vector3(), points = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (const z of new Set(planes)) {
    // Pinned Orca resets contours at either global end plane.
    if (!(z > Math.fround(bounds.min.z) && z < Math.fround(bounds.max.z))) continue;
    const segments = new Set<string>();
    const key = (p: THREE.Vector3) => `${Math.round(p.x / epsilon)},${Math.round(p.y / epsilon)}`;
    for (const mesh of meshes) {
      const tree = (mesh.geometry as THREE.BufferGeometry & { boundsTree: MeshBVH }).boundsTree;
      if (!tree) throw new Error('Height cursor requires the original model BVH');
      const localPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -z).applyMatrix4(mesh.matrix.clone().invert());
      tree.shapecast({
        intersectsBounds: (box) => box.intersectsPlane(localPlane),
        intersectsTriangle: (triangle) => {
          points[0].copy(triangle.a).applyMatrix4(mesh.matrix);
          points[1].copy(triangle.b).applyMatrix4(mesh.matrix);
          points[2].copy(triangle.c).applyMatrix4(mesh.matrix);
          const distances = points.map((p) => Math.abs(p.z - z) <= epsilon ? 0 : p.z - z);
          // Pinned TriangleMeshSlicer::slice_facet owns a triangle's top
          // edge, not its bottom edge. Horizontal faces do not contribute.
          if (distances.every((d) => d >= 0)) return false;
          const intersections: THREE.Vector3[] = [];
          for (let i = 0; i < 3; i++) {
            const j = (i + 1) % 3, a = distances[i], b = distances[j];
            if (a === 0) vertex.copy(points[i]);
            else if (a * b < 0) vertex.copy(points[i]).lerp(points[j], a / (a - b));
            else continue;
            vertex.z = z;
            if (!intersections.some((p) => p.distanceToSquared(vertex) <= epsilon * epsilon)) intersections.push(vertex.clone());
          }
          if (intersections.length !== 2 || intersections[0].distanceToSquared(intersections[1]) <= epsilon * epsilon) return false;
          const keys = intersections.map(key).sort(), segment = keys.join('|');
          if (!segments.has(segment)) {
            segments.add(segment);
            positions.push(...intersections[0].toArray(), ...intersections[1].toArray());
          }
          return false;
        },
      });
    }
  }
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
}

export function heightCursorMaterial(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color: 'white', transparent: true, opacity: 1, depthTest: true, depthWrite: false });
}

export function HeightRangeCursor({ meshes, bounds, hitZ, height, renderOrder }: { meshes: readonly THREE.Mesh[]; bounds: THREE.Box3; hitZ: number; height: number; renderOrder: number }) {
  const [lower, upper] = heightRangePlanes(bounds, hitZ, height);
  // Numerical Z dependencies deliberately exclude XY, colour and native draft
  // receipts. A new cut buffer never remounts the line draw object.
  const geometry = useMemo(() => heightRangeContours(meshes, bounds, [lower, upper]), [meshes, bounds, lower, upper]);
  const material = useMemo(heightCursorMaterial, []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);
  return <group renderOrder={renderOrder}>
    <lineSegments geometry={geometry} material={material} renderOrder={renderOrder} dispose={null}
      name={__ORCA_E2E__ ? 'painting-cursor-height' : undefined}
      userData={__ORCA_E2E__ ? { heightPlanes: [lower, upper], heightBounds: [bounds.min.z, bounds.max.z] } : undefined} />
  </group>;
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
