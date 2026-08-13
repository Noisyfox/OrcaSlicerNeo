// apps/desktop/src/renderer/src/components/viewport/ModelMesh.tsx
import { useRef } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { slicerClient } from '../../slicer/slicerClient';
import type { LoadedObject } from './useModelLoader';

const BED_Y = 0;

export function ModelMesh({ data }: { data: LoadedObject }) {
  const meshRef = useRef<THREE.Mesh>(null);
  // The makeDefault OrbitControls instance (drei sets state.controls; the
  // RootState type is the base EventDispatcher, so narrow to what we use).
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null;
  const selected = useSettingsStore((s) => s.selectedObject === data.buffer.objectIdx);
  const setSelected = useSettingsStore((s) => s.setSelectedObject);
  const setInstanceOffset = useSettingsStore((s) => s.setInstanceOffset);
  const dragRef = useRef<{ plane: THREE.Plane; offset: THREE.Vector3; moved: boolean } | null>(null);

  function select(e: ThreeEvent<MouseEvent>) {
    e.stopPropagation();
    setSelected(data.buffer.objectIdx);
  }

  // Drag-move on the bed plane (left pointer on the selected object).
  // OrbitControls: LEFT = orbit — so drag starts only on the object itself
  // (click-to-select then drag on it); OrbitControls keeps right-drag pan.
  function onPointerDown(e: ThreeEvent<PointerEvent>) {
    if (!selected) return;
    e.stopPropagation();
    const pos = meshRef.current!.position;
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -BED_Y);
    const hit = new THREE.Vector3();
    const ray = e.ray as THREE.Ray;
    if (!ray.intersectPlane(plane, hit)) return;
    dragRef.current = { plane, offset: pos.clone().sub(hit), moved: false };
    // OrbitControls listens natively on the same canvas — r3f's
    // stopPropagation only stops R3F event delivery, so without this the
    // camera would rotate every frame while the model is dragged. Re-enabled
    // in endDrag (pointerup / pointercancel).
    if (controls) controls.enabled = false;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: ThreeEvent<PointerEvent>) {
    const drag = dragRef.current;
    if (!drag) return;
    const hit = new THREE.Vector3();
    if (!(e.ray as THREE.Ray).intersectPlane(drag.plane, hit)) return;
    const next = hit.add(drag.offset);
    next.y = BED_Y;
    drag.moved = true;
    meshRef.current!.position.copy(next);
  }

  // Shared end of gesture — pointerup AND pointercancel both land here:
  // restore orbit, drop the drag state, and commit the offset only if the
  // pointer actually moved (no jitter writes mid-drag).
  async function endDrag() {
    if (controls) controls.enabled = true;
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag?.moved) return;
    // The instance offset is a world/scene coordinate; the mesh position is
    // local to the group at buffer.offset, so the new offset is the original
    // offset plus the accumulated drag delta.
    const pos = meshRef.current!.position;
    const wx = data.buffer.offset[0] + pos.x;
    const wy = data.buffer.offset[1] + pos.y;
    const wz = data.buffer.offset[2] + pos.z;
    const res = await slicerClient.setInstanceOffset(data.buffer.objectIdx, 0, wx, wy, wz);
    if (res.ok) setInstanceOffset([wx, wy, wz]);
  }

  return (
    <group position={[data.buffer.offset[0], data.buffer.offset[1], data.buffer.offset[2]]}>
      <mesh
        ref={meshRef}
        geometry={data.geometry}
        onClick={select}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <meshStandardMaterial
          color={selected ? '#3b82f6' : '#cbd5e1'}
          roughness={0.6}
          metalness={0.1}
        />
      </mesh>
    </group>
  );
}
