import * as THREE from 'three';
import type { MeasureStatus, MeasureVector } from '@slicer/client';

export interface DistanceDimension { readonly from: MeasureVector; readonly to: MeasureVector; readonly value: number }
export interface AngleDimension { readonly points: readonly THREE.Vector3[]; readonly label: THREE.Vector3; readonly radians: number }
export interface MeasureDimensions {
  readonly distance: DistanceDimension | null;
  readonly axes: readonly { readonly from: MeasureVector; readonly to: MeasureVector; readonly color: string }[];
  readonly angle: AngleDimension | null;
}

/** The selected native result supplies both numeric values and endpoints.
 * The sole-circle case uses Orca's circle-to-center result. */
export function measureDimensions(status: MeasureStatus | null): MeasureDimensions {
  const empty: MeasureDimensions = { distance: null, axes: [], angle: null };
  if (!status?.first || (!status.second && status.first.value.type !== 'circle') || !status.result) return empty;
  const result = status.result;
  const source = result.infinite ?? result.strict;
  const distance = source && Math.abs(source.value) >= .001 &&
    new THREE.Vector3(...source.from).distanceToSquared(new THREE.Vector3(...source.to)) >= .000001
    ? { from: source.from, to: source.to, value: source.value } : null;
  const axes: MeasureDimensions['axes'] = distance && status.second ? ([
    { from: distance.from, to: [distance.to[0], distance.from[1], distance.from[2]], color: '#ff4f4f' },
    { from: [distance.to[0], distance.from[1], distance.from[2]], to: [distance.to[0], distance.to[1], distance.from[2]], color: '#5edc71' },
    { from: [distance.to[0], distance.to[1], distance.from[2]], to: distance.to, color: '#4b8bff' },
  ] satisfies MeasureDimensions['axes']).filter(axis => new THREE.Vector3(...axis.from).distanceToSquared(new THREE.Vector3(...axis.to)) >= .000001) : [];
  let angle: AngleDimension | null = null;
  const value = result.angle;
  if (value && Math.abs(value.radians) >= .0001 && Math.abs(value.radius) >= .0001) {
    const first = new THREE.Vector3(...value.edge1[1]).sub(new THREE.Vector3(...value.edge1[0])).normalize();
    const second = new THREE.Vector3(...value.edge2[1]).sub(new THREE.Vector3(...value.edge2[0])).normalize();
    const normal = new THREE.Vector3().crossVectors(first, second);
    if (normal.lengthSq() > 1e-16) {
      normal.normalize();
      const center = new THREE.Vector3(...value.center);
      const count = Math.max(2, Math.trunc(64 * Math.abs(value.radians) / Math.PI));
      const at = (t: number) => first.clone().applyAxisAngle(normal, value.radians * t).multiplyScalar(value.radius).add(center);
      angle = { points: Array.from({ length: count + 1 }, (_, i) => at(i / count)), label: at(.5), radians: value.radians };
    }
  }
  return { distance, axes, angle };
}
