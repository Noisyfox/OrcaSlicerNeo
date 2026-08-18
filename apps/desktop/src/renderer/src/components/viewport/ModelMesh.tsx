// apps/desktop/src/renderer/src/components/viewport/ModelMesh.tsx
// One renderer GLVolume (CompositeID object/volume/instance): body drag via
// drei DragControls (free — no axis lock;
// the drag plane is perpendicular to the camera through the grab point, so
// the body moves in X, Y and Z with the pointer) and, when selected, the
// move gizmo. The DragControls group is the single world-transform owner;
// both drag systems write group.position and commit through the bridge on
// release (see gizmo/commitPosition.ts).
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { DragControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { slicerClient } from '../../slicer/slicerClient';
import { MoveGizmo, type GestureState } from './gizmo/MoveGizmo';
import { commitPosition } from './gizmo/commitPosition';
import type { GLVolume } from './GLVolume';

function applyTransform(group: THREE.Group, transform: GLVolume['instanceTransform']) {
  const { offset, rotation, scale, mirror } = transform;
  group.position.set(...offset);
  group.rotation.set(...rotation);
  group.scale.set(scale[0] * mirror[0], scale[1] * mirror[1], scale[2] * mirror[2]);
}

export function GLVolumeMesh({ data }: { data: GLVolume }) {
  // DragControls forwards its ref to the group it renders — the group whose
  // position is the object's world offset.
  const groupRef = useRef<THREE.Group>(null);
  const volumeGroupRef = useRef<THREE.Group>(null);
  const invalidate = useThree((s) => s.invalidate);
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null;
  const selected = useSettingsStore((s) => s.selectedVolumeId === data.id);
  const setSelected = useSettingsStore((s) => s.setSelectedVolumeId);
  const setObjectOffset = useSettingsStore((s) => s.setObjectOffset);
  const setError = useSlicerStore((s) => s.setError);
  // React state drives re-renders (dragConfig.enabled / TC enabled props);
  // the ref gives drag callbacks synchronous reads.
  const [kind, setKind] = useState<GestureState['kind']>('none');
  const gestureRef = useRef<GestureState>({ kind: 'none', dragStart: [0, 0, 0] });
  // Reused scratch vector — avoid per-event allocation at pointer rate.
  const scratch = useMemo(() => new THREE.Vector3(), []);

  useSettingsStore((s) => s.positions[data.buffer.objectIdx]);
  // The nested groups model the native GLVolume's two transformation layers:
  // instance outside, ModelVolume inside.
  useEffect(() => {
    const g = groupRef.current;
    const volume = volumeGroupRef.current;
    if (!g || !volume) return;
    g.matrixAutoUpdate = true;
    volume.matrixAutoUpdate = true;
    applyTransform(g, data.instanceTransform);
    applyTransform(volume, data.volumeTransform);
    invalidate();
  }, [data.instanceTransform, data.volumeTransform, invalidate]);

  // Deselecting mid-gesture would leave kind='gizmo' (body drag locked out)
  // and OrbitControls disabled — reset both.
  useEffect(() => {
    if (!selected) {
      gestureRef.current.kind = 'none';
      setKind('none');
      if (controls) controls.enabled = true;
    }
  }, [selected]);

  async function commit() {
    const g = groupRef.current;
    if (!g) return;
    const p = g.position;
    const ok = await commitPosition(
      slicerClient,
      data.buffer.objectIdx,
      data.buffer.instanceIdx,
      [p.x, p.y, p.z],
      gestureRef.current.dragStart,
      (msg) => setError(`move: ${msg}`),
    );
    if (!ok) g.position.set(...gestureRef.current.dragStart);
    invalidate();
  }

  return (
    <>
      <DragControls
        ref={groupRef}
        autoTransform={false}
        dragConfig={{ enabled: kind !== 'gizmo' }}
        onDragStart={() => {
          const g = groupRef.current!;
          gestureRef.current = { kind: 'body', dragStart: [g.position.x, g.position.y, g.position.z] };
          setKind('body');
        }}
        onDrag={(localMatrix) => {
          // Mutual exclusion guard: a gizmo-handle press also dispatches
          // pointer events to the mesh behind it; TC's onMouseDown sets kind
          // synchronously via the ref, but this callback can fire before the
          // re-render lands. Only the body gesture writes positions.
          if (gestureRef.current.kind !== 'body') return;
          const g = groupRef.current;
          if (!g) return;
          // drei computed the intended world position for us (autoTransform
          // is off) — apply it through position so matrixAutoUpdate picks it
          // up, and mirror to the store for the move panel.
          scratch.setFromMatrixPosition(localMatrix);
          g.position.copy(scratch);
          setObjectOffset(data.buffer.objectIdx, [scratch.x, scratch.y, scratch.z]);
          invalidate();
        }}
        onDragEnd={() => {
          gestureRef.current.kind = 'none';
          setKind('none');
          void commit();
        }}
      >
        <group ref={volumeGroupRef}>
          <mesh
            geometry={data.geometry}
            onClick={(e) => {
              e.stopPropagation();
              setSelected(data.id);
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
      {selected && groupRef.current && (
        <MoveGizmo
          target={groupRef.current}
          objectIdx={data.buffer.objectIdx}
          instanceIdx={data.buffer.instanceIdx}
          kind={kind}
          setKind={setKind}
          gestureRef={gestureRef}
        />
      )}
    </>
  );
}
