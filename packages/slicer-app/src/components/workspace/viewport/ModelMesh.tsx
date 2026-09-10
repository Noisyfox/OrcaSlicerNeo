// One renderer GLVolume. Prepare models forward pointer events to the scene
// controller; Preview models are passive render-only shells.
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { DragControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useSceneInteraction, useSceneInteractionVersion } from './SceneInteractionContext';
import type { GLVolume } from './GLVolume';
import { MODEL_BODY_RAYCAST } from './buildPlatePointerOcclusion';
import { EULER_ORDER } from './transformDeltaMath';
import { acceleratedRaycast } from 'three-mesh-bvh';
import type { ModelObjectStructure, PlateSessionSnapshot } from '@slicer/client';
import { useFilamentSessionStore } from '../../../stores/useFilamentSessionStore';
import { prepareColourForVolume, resolvePrepareMaterial } from './prepareColourProjection';

function applyTransform(group: THREE.Group, transform: GLVolume['instanceTransform']) {
  if (transform.matrix) {
    group.matrixAutoUpdate = false;
    group.matrix.fromArray(transform.matrix);
    group.matrixWorldNeedsUpdate = true;
    return;
  }
  const { offset, rotation, scale, mirror } = transform;
  group.matrixAutoUpdate = true;
  group.position.set(...offset);
  group.rotation.order = EULER_ORDER;
  group.rotation.set(...rotation);
  group.scale.set(scale[0] * mirror[0], scale[1] * mirror[1], scale[2] * mirror[2]);
  group.updateMatrix();
}

export function GLVolumeMesh({ data, interactive = true, preview = false, structure = [], plateSession, onModelSelection }: {
  data: GLVolume;
  interactive?: boolean;
  preview?: boolean;
  structure?: readonly ModelObjectStructure[];
  plateSession?: PlateSessionSnapshot | null;
  onModelSelection?: () => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const volumeGroupRef = useRef<THREE.Group>(null);
  const bodyStartRef = useRef(new THREE.Vector3());
  const selectedOnPointerDownRef = useRef(false);
  const invalidate = useThree((s) => s.invalidate);
  const sceneInteraction = useSceneInteraction();
  useSceneInteractionVersion();
  const filamentSnapshot = useFilamentSessionStore((state) => state.snapshot);
  const selected = !preview && sceneInteraction.selection.has(data);
  const prepareColour = !preview
    ? prepareColourForVolume(data, structure, filamentSnapshot, plateSession)
    : '#cbd5e1';
  const material = resolvePrepareMaterial({ baseColour: prepareColour, selected, transparent: preview });
  const scratch = useMemo(() => new THREE.Vector3(), []);

  const applySceneTransforms = useCallback(() => {
    const group = groupRef.current;
    const volume = volumeGroupRef.current;
    if (!group || !volume) return;
    group.matrixAutoUpdate = true;
    volume.matrixAutoUpdate = true;
    applyTransform(group, data.instanceTransform);
    applyTransform(volume, data.volumeTransform);
    invalidate();
  }, [data, invalidate]);

  useLayoutEffect(() => {
    applySceneTransforms();
    return sceneInteraction.subscribe(applySceneTransforms);
  }, [applySceneTransforms, data.instanceTransform, data.volumeTransform, sceneInteraction]);

  const modelMesh = (
    <group ref={volumeGroupRef}>
      <mesh
        geometry={data.geometry}
        raycast={acceleratedRaycast}
        userData={{ orcaRaycastRole: MODEL_BODY_RAYCAST, orcaVolume: data }}
        onPointerDown={interactive ? (event) => {
          if (event.nativeEvent.button !== 0) return;
          onModelSelection?.();
          if (!sceneInteraction.pointerStartsOnGizmo) {
            event.nativeEvent.stopImmediatePropagation();
          }
          selectedOnPointerDownRef.current = sceneInteraction.prepareBodyDragFromPointerDown(
            data,
            event.nativeEvent.ctrlKey || event.nativeEvent.metaKey,
            event.nativeEvent.altKey,
          );
        } : undefined}
        onClick={interactive ? (event) => {
          event.stopPropagation();
          if (selectedOnPointerDownRef.current) {
            selectedOnPointerDownRef.current = false;
            return;
          }
          if (sceneInteraction.owner !== 'none') return;
          sceneInteraction.selectFromClick(
            data,
            event.nativeEvent.ctrlKey || event.nativeEvent.metaKey,
            event.nativeEvent.altKey,
          );
        } : undefined}
      >
        <meshStandardMaterial
          color={material.colour}
          roughness={0.6}
          metalness={0.1}
          side={THREE.DoubleSide}
          transparent={material.transparent}
          opacity={material.opacity}
          depthWrite={material.depthWrite}
        />
      </mesh>
    </group>
  );

  if (!interactive) {
    // No DragControls or pointer handlers are mounted in Preview.
    return <group ref={groupRef}>{modelMesh}</group>;
  }

  return (
    <DragControls
      ref={groupRef}
      autoTransform={false}
      axisLock="z"
      dragConfig={{ enabled: sceneInteraction.bodyDragEnabled }}
      onDragStart={(origin) => {
        if (!sceneInteraction.tryBeginBodyDrag()) return;
        bodyStartRef.current.copy(origin);
      }}
      onDrag={(localMatrix) => {
        if (sceneInteraction.owner !== 'body') return;
        const start = sceneInteraction.activeDrag?.startPivot;
        if (!start) return;
        scratch.setFromMatrixPosition(localMatrix).sub(bodyStartRef.current);
        sceneInteraction.updateDragPivot(start.clone().add(scratch));
        invalidate();
      }}
      onDragEnd={() => {
        if (sceneInteraction.owner === 'body') sceneInteraction.endDrag();
      }}
    >
      {modelMesh}
    </DragControls>
  );
}
