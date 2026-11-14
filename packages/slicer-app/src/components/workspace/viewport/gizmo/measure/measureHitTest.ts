import * as THREE from 'three';
import type { MeasureDisplay, MeasureFeature, MeasureStatus, MeasureVector } from '@slicer/client';

type Point = { x: number; y: number };
type Viewport = { left: number; top: number; width: number; height: number };

function project(value: MeasureVector, camera: THREE.Camera, rect: Viewport): Point | null {
  const point = new THREE.Vector3(...value).project(camera);
  if (!point.toArray().every(Number.isFinite) || point.z < -1 || point.z > 1) return null;
  return { x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2 };
}

function segmentDistance(point: Point, a: Point, b: Point): number {
  const x = b.x - a.x, y = b.y - a.y, length = x * x + y * y;
  const t = length ? THREE.MathUtils.clamp(((point.x - a.x) * x + (point.y - a.y) * y) / length, 0, 1) : 0;
  return Math.hypot(point.x - a.x - t * x, point.y - a.y - t * y);
}

/** Conservative synchronous gesture preflight. The native press still owns
 * depth, feature identity and the exact sphere/cylinder/torus intersection. */
export function hitsMeasureGripper(point: Point, camera: THREE.Camera, rect: Viewport, display: MeasureDisplay | null, status?: MeasureStatus | null): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  camera.updateMatrixWorld();
  for (const marker of display?.markers ?? []) {
    const screen = project(marker.position, camera, rect);
    if (screen && Math.hypot(point.x - screen.x, point.y - screen.y) <= 9) return true;
  }
  const features: MeasureFeature[] = [];
  for (const item of display ? [display.first, display.second] : [status?.first, status?.second]) {
    if (item?.value.type === 'point') {
      const screen = project(item.value.point, camera, rect);
      if (screen && Math.hypot(point.x - screen.x, point.y - screen.y) <= 9) return true;
    }
    if (item?.kind === 'feature') features.push(item.source);
  }
  if (display?.hover?.feature) features.push(display.hover.feature);
  for (const feature of features) {
    if (feature.type === 'edge') {
      const a = project(feature.start, camera, rect), b = project(feature.end, camera, rect);
      if (a && b && segmentDistance(point, a, b) <= 7) return true;
    } else if (feature.type === 'circle') {
      const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...feature.normal).normalize());
      const center = new THREE.Vector3(...feature.center);
      let previous: Point | null = null;
      for (let index = 0; index <= 64; index++) {
        const angle = index * 2 * Math.PI / 64;
        const world = new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0).multiplyScalar(feature.radius).applyQuaternion(rotation).add(center);
        const next = project(world.toArray() as [number, number, number], camera, rect);
        if (previous && next && segmentDistance(point, previous, next) <= 7) return true;
        previous = next;
      }
    }
  }
  return false;
}
