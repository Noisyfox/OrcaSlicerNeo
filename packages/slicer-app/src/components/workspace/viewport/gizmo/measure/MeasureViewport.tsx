import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import type { MeasureFeature, MeasureVector } from '@slicer/client';
import type { SceneInteractionController } from '../../SceneInteractionController';
import { useMeasureController, useMeasureState } from './MeasureProvider';
import { installMeasureInput } from './MeasureInput';
import { MeasurePlaneResources } from './MeasurePlaneResources';
import { MeasureSurfacePicker } from './MeasureSurfacePicker';
import { MeasureDimensions } from './MeasureDimensions';

const noRaycast: THREE.Object3D['raycast'] = () => undefined;
const firstColor = '#32a7ff', secondColor = '#ffab4d', hoverColor = '#72e8ff';

/** World units per CSS pixel at the projected point, for both camera kinds. */
export function measurePixelScale(camera: THREE.Camera, height: number, point: MeasureVector): number {
  const clip = new THREE.Vector4(...point, 1).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
  return Math.abs(2 * clip.w / (height * camera.projectionMatrix.elements[5]));
}

function ScreenMarker({ position, color }: { position: MeasureVector; color: string }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ camera, size }) => {
    if (!ref.current || size.height <= 0) return;
    const scale = measurePixelScale(camera, size.height, position);
    if (Number.isFinite(scale)) ref.current.scale.setScalar(scale);
  });
  return <mesh ref={ref} position={[...position]} raycast={noRaycast} renderOrder={4}>
    <sphereGeometry args={[7.5, 16, 16]} />
    <meshBasicMaterial color={color} depthWrite={false} />
  </mesh>;
}

function circlePoints(feature: Extract<MeasureFeature, { type: 'circle' }>): THREE.Vector3[] {
  const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...feature.normal).normalize());
  const center = new THREE.Vector3(...feature.center);
  return Array.from({ length: 65 }, (_, i) => {
    const angle = i * 2 * Math.PI / 64;
    return new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0).multiplyScalar(feature.radius).applyQuaternion(rotation).add(center);
  });
}

function FeatureVisual({ feature, color, planes }: { feature: MeasureFeature; color: string; planes: MeasurePlaneResources }) {
  if (feature.type === 'point') return <ScreenMarker position={feature.point} color={color} />;
  if (feature.type === 'edge') return <Line points={[feature.start, feature.end]} color={color} lineWidth={3} depthWrite={false} raycast={noRaycast} />;
  if (feature.type === 'circle') return <Line points={circlePoints(feature)} color={color} lineWidth={3} depthWrite={false} raycast={noRaycast} />;
  const resource = planes.get(feature.resourceId);
  if (!resource) return null;
  return <mesh geometry={resource.geometry} matrix={resource.matrix} matrixAutoUpdate={false} raycast={noRaycast} renderOrder={2}>
    <meshBasicMaterial color={color} transparent opacity={0.35} side={THREE.DoubleSide} depthWrite={false} />
  </mesh>;
}

function planeIds(features: readonly (MeasureFeature | null | undefined)[]): Set<string> {
  return new Set(features.filter((feature): feature is Extract<MeasureFeature, { type: 'plane' }> => feature?.type === 'plane')
    .map(feature => feature.resourceId));
}

/** Draw compact native features and connect captured input to the shared lane. */
export function MeasureViewport({ sceneInteraction }: { sceneInteraction: SceneInteractionController }) {
  const controller = useMeasureController()!;
  const state = useMeasureState()!;
  const camera = useThree(value => value.camera);
  const gl = useThree(value => value.gl);
  const controls = useThree(value => value.controls);
  const invalidate = useThree(value => value.invalidate);
  const resources = useMemo(() => new MeasurePlaneResources(), []);
  const surfacePicker = useMemo(() => new MeasureSurfacePicker(), []);
  const [, setResourceVersion] = useState(0);
  useLayoutEffect(() => { resources.sync(state.planes); setResourceVersion(value => value + 1); }, [resources, state.planes]);
  const display = state.display;
  const first = display ? display.first : state.status?.first;
  const second = display ? display.second : state.status?.second;
  const hover = display?.hover?.feature;
  const visiblePlanes = planeIds([first?.value, second?.value, hover]);
  const planesRef = useRef(visiblePlanes); planesRef.current = visiblePlanes;
  useEffect(() => { invalidate(); }, [state, invalidate]);
  useEffect(() => () => resources.dispose(), [resources]);
  useEffect(() => () => surfacePicker.dispose(), [surfacePicker]);
  useEffect(() => {
    const orbit = controls as unknown as { target: THREE.Vector3; enableDamping: boolean; update(): void } | undefined;
    if (!orbit) return;
    return installMeasureInput({ canvas: gl.domElement, camera, controls: orbit, controller,
      pivot: () => sceneInteraction.selectionPivot() ?? orbit.target,
      invalidate,
      hitsSurface: event => {
        const rect = gl.domElement.getBoundingClientRect();
        const meshes = [...planesRef.current].map(id => resources.get(id)?.pick).filter((mesh): mesh is THREE.Mesh => !!mesh);
        return surfacePicker.hits(event, rect, camera, sceneInteraction.selectedVolumes(), meshes);
      },
    });
  }, [camera, controller, controls, gl, invalidate, resources, sceneInteraction, surfacePicker]);
  return <>
    {first && <FeatureVisual feature={first.value} color={firstColor} planes={resources} />}
    {second && <FeatureVisual feature={second.value} color={secondColor} planes={resources} />}
    {hover && <FeatureVisual feature={hover} color={hoverColor} planes={resources} />}
    {display?.markers.map(marker => <ScreenMarker key={marker.index} position={marker.position} color={hoverColor} />)}
    <MeasureDimensions status={display ?? state.status} />
  </>;
}
