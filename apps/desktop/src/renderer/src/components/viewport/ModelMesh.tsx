// One renderer GLVolume. Meshes only render and forward pointer events; the
// scene controller owns complete selection, body-drag lifecycle, and the
// single TransformControls gizmo.
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { DragControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useSceneInteraction, useSceneInteractionVersion } from './SceneInteractionContext';
import type { GLVolume } from './GLVolume';

function applyTransform(group: THREE.Group, transform: GLVolume['instanceTransform']) {
  const { offset, rotation, scale, mirror } = transform;
  group.position.set(...offset);
  group.rotation.set(...rotation);
  group.scale.set(scale[0] * mirror[0], scale[1] * mirror[1], scale[2] * mirror[2]);
}

export function GLVolumeMesh({ data }: { data: GLVolume }) {
  const groupRef = useRef<THREE.Group>(null);
  const volumeGroupRef = useRef<THREE.Group>(null);
  const bodyStartRef = useRef(new THREE.Vector3());
  const invalidate = useThree((s) => s.invalidate);
  const sceneInteraction = useSceneInteraction();
  useSceneInteractionVersion();
  const selected = sceneInteraction.selection.has(data);
  const scratch = useMemo(() => new THREE.Vector3(), []);

  // Native transform layering: ModelInstance outside and ModelVolume inside.
  // The controller mutates local GLVolume state; this applies it to the scene.
  useEffect(() => {
    const group = groupRef.current;
    const volume = volumeGroupRef.current;
    if (!group || !volume) return;
    group.matrixAutoUpdate = true;
    volume.matrixAutoUpdate = true;
    applyTransform(group, data.instanceTransform);
    applyTransform(volume, data.volumeTransform);
    invalidate();
  }, [data.instanceTransform, data.volumeTransform, invalidate]);

  return (
    <DragControls
      ref={groupRef}
      autoTransform={false}
      dragConfig={{ enabled: sceneInteraction.bodyDragEnabled }}
      onDragStart={() => {
        // A new body drag selects its hit's complete instance before taking a
        // snapshot. A gizmo's synchronous claim makes this a no-op for an
        // overlapping TransformControls grabber.
        if (!sceneInteraction.selection.has(data) && sceneInteraction.owner === 'none') {
          sceneInteraction.selectFromHit(data, false);
        }
        if (!sceneInteraction.tryBeginBodyDrag()) return;
        const group = groupRef.current;
        if (group) bodyStartRef.current.copy(group.position);
      }}
      onDrag={(localMatrix) => {
        // Final ownership guard: r3f can dispatch a mesh event after a gizmo
        // claimed the same press. autoTransform is off, so it cannot mutate.
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
      <group ref={volumeGroupRef}>
        <mesh
          geometry={data.geometry}
          onClick={(event) => {
            event.stopPropagation();
            if (sceneInteraction.owner !== 'none') return;
            sceneInteraction.selectFromHit(data, event.nativeEvent.ctrlKey || event.nativeEvent.metaKey);
          }}
        >
          <meshStandardMaterial
            color={selected ? '#3b82f6' : '#cbd5e1'}
            roughness={0.6}
            metalness={0.1}
          />
        </mesh>
      </group>
    </DragControls>
  );
}
