import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import type { MeasureStatus } from '@slicer/client';
import { measureDimensions } from './dimensionGeometry';
import { measureLength, measureNumber } from './measurePresentation';
import type { MeasureScaleRequest } from './measureScale';
import { Pencil } from 'lucide-react';

const noRaycast: THREE.Object3D['raycast'] = () => undefined;

export function MeasureDimensions({ status, canEdit, onEdit }: {
  status: MeasureStatus | null; canEdit: boolean; onEdit: (request: MeasureScaleRequest) => void;
}) {
  const { distance, axes, angle } = measureDimensions(status);
  return <>
    {axes.map((axis, i) => <Line key={i} points={[axis.from, axis.to]} color={axis.color} lineWidth={2}
      depthTest={false} depthWrite={false} raycast={noRaycast} renderOrder={10} />)}
    {distance && <>
      <Line points={[distance.from, distance.to]} color="white" lineWidth={2}
        depthTest={false} depthWrite={false} raycast={noRaycast} renderOrder={11} />
      <Html position={new THREE.Vector3(...distance.from).add(new THREE.Vector3(...distance.to)).multiplyScalar(.5)} center>
        <div className="flex items-center gap-0.5 rounded-sm bg-white/80 px-1 py-0.5 text-xs whitespace-nowrap text-black">
          <span data-testid="measure-dimension">{measureLength(distance.value)}</span>
          {status?.sameTarget && canEdit && <button type="button" aria-label="Edit to scale" data-testid="measure-edit-scale"
            className="rounded p-0.5 hover:bg-black/10" onClick={() => onEdit({ sessionId: status.sessionId,
              targetRevision: status.targetRevision, selectionRevision: status.selectionRevision, value: distance.value })}>
            <Pencil className="size-3" />
          </button>}
        </div>
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
