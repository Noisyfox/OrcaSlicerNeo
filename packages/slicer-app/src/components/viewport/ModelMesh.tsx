// One renderer GLVolume. Meshes only render and forward pointer events; the
// scene controller owns complete selection, body-drag lifecycle, and the
// single TransformControls gizmo.
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { DragControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useSceneInteraction, useSceneInteractionVersion } from './SceneInteractionContext';
import type { GLVolume } from './GLVolume';
import { MODEL_BODY_RAYCAST } from './buildPlatePointerOcclusion';
import { persistSettledModelTransforms } from '../toolbar/persistModelTransforms';
import { usePlatform } from '@orca/platform-contract';
import { EULER_ORDER } from './transformDeltaMath';

function applyTransform(group: THREE.Group, transform: GLVolume['instanceTransform']) {
  // A sheared transform cannot be split into position/quaternion/scale; apply
  // its matrix directly so the mesh renders (and slices) exactly as stored.
  if (transform.matrix) {
    group.matrixAutoUpdate = false;
    group.matrix.fromArray(transform.matrix);
    group.matrixWorldNeedsUpdate = true;
    return;
  }
  const { offset, rotation, scale, mirror } = transform;
  group.matrixAutoUpdate = true;
  group.position.set(...offset);
  // Match the C++ slicer's Rz·Ry·Rx composition (see the rotate/scale design
  // doc) — three's default XYZ order would render non-zero rotations
  // differently from the sliced result.
  group.rotation.order = EULER_ORDER;
  group.rotation.set(...rotation);
  group.scale.set(scale[0] * mirror[0], scale[1] * mirror[1], scale[2] * mirror[2]);
  // DragControls reads this matrix on the next pointer event. Keep it current
  // now rather than waiting for React/fiber's next render frame.
  group.updateMatrix();
}

export function GLVolumeMesh({ data }: { data: GLVolume }) {
  const platform = usePlatform();
  const groupRef = useRef<THREE.Group>(null);
  const volumeGroupRef = useRef<THREE.Group>(null);
  const bodyStartRef = useRef(new THREE.Vector3());
  const selectedOnPointerDownRef = useRef(false);
  const invalidate = useThree((s) => s.invalidate);
  const sceneInteraction = useSceneInteraction();
  useSceneInteractionVersion();
  const selected = sceneInteraction.selection.has(data);
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

  // Native transform layering: ModelInstance outside and ModelVolume inside.
  // Apply a controller update synchronously, alongside the gizmo's imperative
  // target mutation; React's selection render is only for visual styling.
  useLayoutEffect(() => {
    applySceneTransforms();
    return sceneInteraction.subscribe(applySceneTransforms);
  }, [applySceneTransforms, sceneInteraction]);

  return (
    <DragControls
      ref={groupRef}
      autoTransform={false}
      // Body drags stay planar: drei constrains the drag plane to world-XY
      // through the grab point, so Z keeps the object's current height.
      // Lifts come from the gizmo Z arrow and the move panel (design doc
      // Amendments, 2026-08-18).
      axisLock="z"
      dragConfig={{ enabled: sceneInteraction.bodyDragEnabled }}
      onDragStart={(origin) => {
        if (!sceneInteraction.tryBeginBodyDrag()) return;
        bodyStartRef.current.copy(origin);
      }}
      onDrag={(localMatrix) => {
        // Final ownership guard: r3f can dispatch a mesh event after a gizmo
        // claimed the same press. autoTransform is off, so it cannot mutate.
        if (sceneInteraction.owner !== 'body') return;
        const start = sceneInteraction.activeDrag?.startPivot;
        if (!start) return;
        // Drei supplies the absolute intended group position. Compare it with
        // the gesture's initial position so every update maps directly to the
        // cursor rather than accumulating or reusing a stale matrix delta.
        scratch.setFromMatrixPosition(localMatrix).sub(bodyStartRef.current);
        sceneInteraction.updateDragPivot(start.clone().add(scratch));
        invalidate();
      }}
      onDragEnd={() => {
        if (sceneInteraction.owner === 'body' && sceneInteraction.endDrag()) {
          void persistSettledModelTransforms(platform.runtime);
        }
      }}
    >
      <group ref={volumeGroupRef}>
        <mesh
          geometry={data.geometry}
          // orcaVolume lets DOM-level pickers (Shift+click fallback in the
          // viewport) map a raycast hit straight back to its GLVolume.
          userData={{ orcaRaycastRole: MODEL_BODY_RAYCAST, orcaVolume: data }}
          onPointerDown={(event) => {
            if (event.nativeEvent.button !== 0) return;
            if (!sceneInteraction.pointerStartsOnGizmo) {
              // R3F's canvas listener is registered before OrbitControls.
              // DragControls has a movement threshold, so prevent the camera
              // control from seeing this body press and rotating before the
              // body gesture claims it. A gizmo-origin press must still reach
              // TransformControls, which has priority over body dragging.
              event.nativeEvent.stopImmediatePropagation();
            }
            // Do this before DragControls observes movement. Besides making
            // click selection immediate, it lets this very press become a
            // drag even when nothing had been selected beforehand.
            selectedOnPointerDownRef.current = sceneInteraction.prepareBodyDragFromPointerDown(
              data,
              event.nativeEvent.ctrlKey || event.nativeEvent.metaKey,
            );
          }}
          onClick={(event) => {
            event.stopPropagation();
            if (selectedOnPointerDownRef.current) {
              selectedOnPointerDownRef.current = false;
              return;
            }
            if (sceneInteraction.owner !== 'none') return;
            sceneInteraction.selectFromClick(data, event.nativeEvent.ctrlKey || event.nativeEvent.metaKey);
          }}
        >
          <meshStandardMaterial
            color={selected ? '#3b82f6' : '#cbd5e1'}
            roughness={0.6}
            metalness={0.1}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>
    </DragControls>
  );
}
