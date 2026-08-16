// apps/desktop/src/renderer/src/components/viewport/gizmo/MoveGizmo.tsx
// The move gizmo: drei TransformControls in translate mode, attached to the
// selected object's DragControls group. Owns the gizmo gesture lifecycle —
// mutual exclusion with the body drag (kind/gestureRef), orbit disable,
// demand-render invalidation, and the bridge commit on release.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { TransformControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { slicerClient } from '../../../slicer/slicerClient';
import { commitPosition } from './commitPosition';
import type { Vec3 } from '../../../lib/vec3';

/** Shared gesture state between the body drag (ModelMesh) and the gizmo.
 *  `kind` mirrors into React state (re-render) and this ref (synchronous
 *  reads inside drag callbacks); `dragStart` feeds the commit-failure
 *  revert. */
export interface GestureState {
  kind: 'none' | 'body' | 'gizmo';
  dragStart: Vec3;
}

type GestureKind = GestureState['kind'];

export function MoveGizmo({ target, objectIdx, kind, setKind, gestureRef }: {
  target: THREE.Object3D;
  objectIdx: number;
  kind: GestureKind;
  setKind: (k: GestureKind) => void;
  gestureRef: React.MutableRefObject<GestureState>;
}) {
  // makeDefault OrbitControls (drei sets state.controls); narrow to what we use.
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null;
  const invalidate = useThree((s) => s.invalidate);
  const setObjectOffset = useSettingsStore((s) => s.setObjectOffset);
  const setError = useSlicerStore((s) => s.setError);
  // Whether TransformControls is mid-drag: a handle press WITHOUT movement
  // never fires dragging-changed(false), so onMouseUp needs to distinguish
  // "drag just ended" (already reset) from "press never became a drag".
  const draggingRef = useRef(false);
  // drei 10.7.8 has no onDraggingChanged prop (absent from its
  // TransformControlsProps and never registered by the wrapper), so listen
  // on the controls instance drei forwards through `ref` instead — the
  // dispatched event is the same 'dragging-changed' { value } three fires.
  const tcRef = useRef<React.ComponentRef<typeof TransformControls> | null>(null);
  useEffect(() => {
    const tc = tcRef.current;
    if (!tc) return;
    // addEventListener is generic over Object3DEventMap in @types/three and
    // 'dragging-changed' is not a member — widen for this one event.
    const evented = tc as unknown as {
      addEventListener(t: 'dragging-changed', l: (e: { value: boolean }) => void): void;
      removeEventListener(t: 'dragging-changed', l: (e: { value: boolean }) => void): void;
    };
    const onDraggingChanged = (e: { value: boolean }) => {
      draggingRef.current = e.value;
      if (e.value) return; // start handled in onMouseDown
      resetGesture();
      void endDrag();
    };
    evented.addEventListener('dragging-changed', onDraggingChanged);
    return () => evented.removeEventListener('dragging-changed', onDraggingChanged);
  }, [controls]);

  // Test-only axis getter (mock/e2e builds): the e2e gizmo test polls this
  // to wait for the picker's hover hit-test (axis is set by pointerHover)
  // before pressing, instead of inferring engagement from pixels. No-op in
  // production builds (VITE_USE_MOCK is unset).
  useEffect(() => {
    if (!(import.meta.env as { VITE_USE_MOCK?: string }).VITE_USE_MOCK) return;
    const w = window as unknown as { __orcaE2e?: { gizmoAxis?: () => string | null } };
    if (!w.__orcaE2e) return; // Scene owns the container and mounts first
    // The axis field is private in three-stdlib's types — widen minimally.
    const readAxis = () => (tcRef.current as unknown as { axis: string | null } | null)?.axis ?? null;
    w.__orcaE2e = { ...w.__orcaE2e, gizmoAxis: readAxis };
    return () => {
      if (w.__orcaE2e) {
        const { gizmoAxis: _dropped, ...rest } = w.__orcaE2e;
        w.__orcaE2e = rest;
      }
    };
  }, []);

  function startDrag() {
    const p = target.position;
    gestureRef.current = { kind: 'gizmo', dragStart: [p.x, p.y, p.z] };
    setKind('gizmo');
    draggingRef.current = false;
    // TransformControls does not touch OrbitControls — mirror the body-drag
    // pattern and disable orbit while the gizmo is active.
    if (controls) controls.enabled = false;
  }

  function onObjectChange() {
    const p = target.position;
    setObjectOffset(objectIdx, [p.x, p.y, p.z]);
    invalidate(); // demand mode: TC mutations never invalidate on their own
  }

  function resetGesture() {
    gestureRef.current.kind = 'none';
    setKind('none');
    if (controls) controls.enabled = true;
  }

  async function endDrag() {
    const p = target.position;
    const ok = await commitPosition(
      slicerClient,
      objectIdx,
      [p.x, p.y, p.z],
      gestureRef.current.dragStart,
      (msg) => setError(`move: ${msg}`),
    );
    // The store was live during the drag; on bridge failure it is already
    // reverted by commitPosition — mirror that on the group.
    if (!ok) target.position.set(...gestureRef.current.dragStart);
    invalidate();
  }

  return (
    <TransformControls
      ref={tcRef}
      object={target}
      mode="translate"
      space="world"
      enabled={kind !== 'body'}
      onMouseDown={startDrag}
      onObjectChange={onObjectChange}
      onMouseUp={() => {
        // Press without movement never dragged — close the gesture so the
        // body drag does not stay locked out (dragConfig enabled: false).
        if (!draggingRef.current && gestureRef.current.kind === 'gizmo') resetGesture();
      }}
    />
  );
}
