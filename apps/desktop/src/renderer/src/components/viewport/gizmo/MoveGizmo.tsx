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
  const tcRef = useRef<React.ComponentRef<typeof TransformControls> | null>(null);

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
