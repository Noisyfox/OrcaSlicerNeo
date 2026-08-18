// The scene's sole move gizmo. TransformControls manipulates a non-rendering
// aggregate-selection pivot; the scene controller applies that delta to every
// selected instance. No GLVolume mesh owns a gizmo or gesture state.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { TransformControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useSceneInteraction } from '../SceneInteractionContext';

export function MoveGizmo({ target }: { target: THREE.Object3D }) {
  const sceneInteraction = useSceneInteraction();
  const invalidate = useThree((s) => s.invalidate);
  const domElement = useThree((s) => s.gl.domElement);
  const tcRef = useRef<React.ComponentRef<typeof TransformControls> | null>(null);

  // The native TransformControls pointer handler repeats this picker query on
  // pointerdown. Register the same query with the viewport capture phase so
  // DragControls sees an up-to-date grabber result before its own callback.
  useEffect(() => {
    sceneInteraction.registerGizmoGrabberHitTest((event) => {
      const controls = tcRef.current as unknown as {
        axis: string | null;
        pointerHover: (pointer: { x: number; y: number; button: number }) => void;
      } | null;
      if (!controls) return false;
      const bounds = domElement.getBoundingClientRect();
      controls.pointerHover({
        x: ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        y: -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
        button: event.button,
      });
      return controls.axis !== null;
    });
    return () => sceneInteraction.registerGizmoGrabberHitTest(null);
  }, [domElement, sceneInteraction]);

  // TransformControls stores its current grabber in `axis`. This disables
  // body drag while hovering a handle; beginGizmoDrag is the synchronous,
  // final ownership claim when the handle is pressed.
  useFrame(() => {
    const axis = (tcRef.current as unknown as { axis: string | null } | null)?.axis ?? null;
    sceneInteraction.setGizmoGrabberHovered(axis !== null);
  });

  // Test-only axis getter (mock/e2e builds). Scene owns the shared container.
  useEffect(() => {
    if (!(import.meta.env as { VITE_USE_MOCK?: string }).VITE_USE_MOCK) return;
    const w = window as unknown as { __orcaE2e?: { gizmoAxis?: () => string | null } };
    if (!w.__orcaE2e) return;
    const readAxis = () => (tcRef.current as unknown as { axis: string | null } | null)?.axis ?? null;
    w.__orcaE2e = { ...w.__orcaE2e, gizmoAxis: readAxis };
    return () => {
      if (w.__orcaE2e) {
        const { gizmoAxis: _dropped, ...rest } = w.__orcaE2e;
        w.__orcaE2e = rest;
      }
    };
  }, []);

  return (
    <TransformControls
      ref={tcRef}
      object={target}
      mode="translate"
      space="world"
      enabled={sceneInteraction.owner !== 'body'}
      onMouseDown={() => { sceneInteraction.beginGizmoDrag(); }}
      onObjectChange={() => {
        if (sceneInteraction.owner !== 'gizmo') return;
        sceneInteraction.updateDragPivot(target.position);
        invalidate();
      }}
      onMouseUp={() => {
        if (sceneInteraction.owner === 'gizmo') sceneInteraction.endDrag();
      }}
    />
  );
}
