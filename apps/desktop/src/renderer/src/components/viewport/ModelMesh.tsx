// apps/desktop/src/renderer/src/components/viewport/ModelMesh.tsx
// One loaded object: body drag via drei DragControls (free — no axis lock;
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
import type { LoadedObject } from './useModelLoader';
import { MoveGizmo, type GestureState } from './gizmo/MoveGizmo';
import { commitPosition } from './gizmo/commitPosition';

export function ModelMesh({ data }: { data: LoadedObject }) {
  // DragControls forwards its ref to the group it renders — the group whose
  // position is the object's world offset.
  const groupRef = useRef<THREE.Group>(null);
  const invalidate = useThree((s) => s.invalidate);
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null;
  const selected = useSettingsStore((s) => s.selectedObject === data.buffer.objectIdx);
  const setSelected = useSettingsStore((s) => s.setSelectedObject);
  const setObjectOffset = useSettingsStore((s) => s.setObjectOffset);
  const setError = useSlicerStore((s) => s.setError);
  // React state drives re-renders (dragConfig.enabled / TC enabled props);
  // the ref gives drag callbacks synchronous reads.
  const [kind, setKind] = useState<GestureState['kind']>('none');
  const gestureRef = useRef<GestureState>({ kind: 'none', dragStart: [0, 0, 0] });
  // Reused scratch vector — avoid per-event allocation at pointer rate.
  const scratch = useMemo(() => new THREE.Vector3(), []);

  const pos = useSettingsStore((s) => s.positions[data.buffer.objectIdx]);
  // Seed the DragControls group's position from the store (seeded at load)
  // and keep it in sync with committed moves (move panel, drop to bed,
  // reset). drei set matrixAutoUpdate: false — re-enable so position writes
  // reach the rendered matrix. Drag paths already write both the store and
  // the group, so this is a no-op during drags.
  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.matrixAutoUpdate = true;
    const p = pos ?? data.buffer.offset;
    g.position.set(p[0], p[1], p[2]);
    invalidate();
  }, [pos, data.buffer.offset, invalidate]);

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
        <mesh
          geometry={data.geometry}
          onClick={(e) => {
            e.stopPropagation();
            setSelected(data.buffer.objectIdx);
          }}
        >
          <meshStandardMaterial
            color={selected ? '#3b82f6' : '#cbd5e1'}
            roughness={0.6}
            metalness={0.1}
          />
        </mesh>
      </DragControls>
      {selected && groupRef.current && (
        <MoveGizmo
          target={groupRef.current}
          objectIdx={data.buffer.objectIdx}
          kind={kind}
          setKind={setKind}
          gestureRef={gestureRef}
        />
      )}
    </>
  );
}
