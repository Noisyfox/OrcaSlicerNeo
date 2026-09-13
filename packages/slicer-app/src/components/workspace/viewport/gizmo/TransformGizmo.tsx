// The scene's sole transform gizmo. TransformControls manipulates a
// non-rendering aggregate-selection pivot; the scene controller applies the
// pivot's delta to every selected instance. One component, three modes —
// translate (move), rotate, and scale (world/local per the scale panel).
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { TransformControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useSceneInteraction } from '../SceneInteractionContext';

export type TransformGizmoMode = 'translate' | 'rotate' | 'scale';

export function TransformGizmo({ target, mode }: {
  target: THREE.Object3D;
  mode: TransformGizmoMode;
}) {
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
    const controls = tcRef.current as unknown as {
      axis: string | null;
      dragging?: boolean;
      worldPositionStart: THREE.Vector3;
      worldPosition: THREE.Vector3;
    } | null;
    const axis = controls?.axis ?? null;
    sceneInteraction.setGizmoGrabberHovered(axis !== null);
    // three-stdlib's TransformControls anchors the hover axis helper (the
    // reference line through a rotation ring) at worldPositionStart, which is
    // only captured at pointerDown — before the first drag it stays at the
    // scene origin, so the line points through the wrong point until the user
    // starts rotating. Keep it on the live pivot between drags; pointerDown
    // re-captures it from the object's matrixWorld at drag start, so this
    // write never interferes with the drag math.
    if (controls && axis !== null && !controls.dragging) {
      controls.worldPositionStart.copy(controls.worldPosition);
    }
  });

  // Test-only axis getter (mock/e2e builds). Scene owns the shared container.
  useEffect(() => {
    const env = import.meta.env as { VITE_USE_MOCK?: string; VITE_E2E?: string; MODE?: string };
    if (!env.VITE_USE_MOCK && env.VITE_E2E !== '1' && env.MODE !== 'e2e') return;
    const w = window as unknown as {
      __orcaE2e?: { gizmoAxis?: () => string | null; gizmoAxisLineWorldPosition?: () => [number, number, number] | null };
    };
    if (!w.__orcaE2e) return;
    const readAxis = () => (tcRef.current as unknown as { axis: string | null } | null)?.axis ?? null;
    const readAxisLineWorldPosition = () => {
      const controls = tcRef.current as unknown as {
        _gizmo?: { helper?: { rotate?: { children?: THREE.Object3D[] } } };
        worldPosition?: THREE.Vector3;
      } | null;
      // three-stdlib exposes the gizmo as `gizmo` (not `_gizmo`).
      const gizmo = controls as unknown as {
        gizmo?: { helper?: { rotate?: { children?: THREE.Object3D[] } } };
      } | null;
      const axis = gizmo?.gizmo?.helper?.rotate?.children?.find((child) => child.name === 'AXIS');
      if (!axis) return null;
      const world = new THREE.Vector3();
      axis.getWorldPosition(world);
      return [world.x, world.y, world.z] as [number, number, number];
    };
    w.__orcaE2e = {
      ...w.__orcaE2e,
      gizmoAxis: readAxis,
      gizmoAxisLineWorldPosition: readAxisLineWorldPosition,
    };
    return () => {
      if (w.__orcaE2e) {
        const { gizmoAxis: _dropped, gizmoAxisLineWorldPosition: _line, ...rest } = w.__orcaE2e;
        w.__orcaE2e = rest;
      }
    };
  }, []);

  return (
    <TransformControls
      ref={tcRef}
      object={target}
      mode={mode}
      space="world"
      showZ={!sceneInteraction.hasWipeTowerSelection}
      enabled={sceneInteraction.owner !== 'body'}
      onMouseDown={() => { sceneInteraction.beginGizmoDrag(); }}
      onObjectChange={() => {
        if (sceneInteraction.owner !== 'gizmo') return;
        // The controller computes the mode-specific delta from the pivot's
        // full transform relative to the gesture's captured start.
        sceneInteraction.updateGizmoTransform({
          position: target.position,
          quaternion: target.quaternion,
          scale: target.scale,
        });
        invalidate();
      }}
      onMouseUp={() => {
        if (sceneInteraction.owner === 'gizmo') sceneInteraction.endDrag();
      }}
    />
  );
}
