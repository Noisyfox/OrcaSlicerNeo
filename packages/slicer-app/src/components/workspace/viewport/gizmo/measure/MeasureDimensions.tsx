import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import type { MeasureStatus } from '@slicer/client';
import { measureDimensions } from './dimensionGeometry';
import { measureLength, measureNumber } from './measurePresentation';

const noRaycast: THREE.Object3D['raycast'] = () => undefined;

export function MeasureDimensions({ status }: { status: MeasureStatus | null }) {
  const { distance, axes, angle } = measureDimensions(status);
  return <>
    {axes.map((axis, i) => <Line key={i} points={[axis.from, axis.to]} color={axis.color} lineWidth={2}
      depthTest={false} depthWrite={false} raycast={noRaycast} renderOrder={10} />)}
    {distance && <>
      <Line points={[distance.from, distance.to]} color="white" lineWidth={2}
        depthTest={false} depthWrite={false} raycast={noRaycast} renderOrder={11} />
      <Html position={new THREE.Vector3(...distance.from).add(new THREE.Vector3(...distance.to)).multiplyScalar(.5)} center
        style={{ pointerEvents: 'none' }}>
        <span className="rounded-sm bg-white/80 px-1 py-0.5 text-xs whitespace-nowrap text-black" data-testid="measure-dimension">
          {measureLength(distance.value)}
        </span>
      </Html>
    </>}
    {angle && <>
      <Line points={angle.points as THREE.Vector3[]} color="white" lineWidth={2} depthTest={false} depthWrite={false}
        raycast={noRaycast} renderOrder={11} />
      <Html position={angle.label} center style={{ pointerEvents: 'none' }}>
        <span className="rounded-sm bg-white/80 px-1 py-0.5 text-xs whitespace-nowrap text-black" data-testid="measure-angle-dimension">
          {measureNumber(angle.radians * 180 / Math.PI)}°
        </span>
      </Html>
    </>}
  </>;
}
