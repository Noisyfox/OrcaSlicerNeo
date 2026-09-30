import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { heightRangeContours, heightRangePlanes } from './heightRangeContours';

declare const __ORCA_E2E__: boolean;

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
