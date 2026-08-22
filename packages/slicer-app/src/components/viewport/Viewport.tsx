// packages/slicer-app/src/components/viewport/Viewport.tsx
import { Component, useCallback, useEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import * as THREE from 'three';
import { Canvas, events as createPointerEvents, type RootState } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport, Stats } from '@react-three/drei';
import { Scene } from './Scene';
import { LayerScrubber } from './LayerScrubber';
import { GizmoToolbar } from './GizmoToolbar';
import type { SceneInteractionController } from './SceneInteractionController';
import { filterBuildPlateOccludedIntersections } from './buildPlatePointerOcclusion';
import { isViewportRaycastingEnabled } from './viewportRaycasting';

const viewportEvents: ComponentProps<typeof Canvas>['events'] = (state) => {
  const defaultEvents = createPointerEvents(state);
  return {
    ...defaultEvents,
    filter: (intersections) => filterBuildPlateOccludedIntersections(intersections),
  };
};

// WebGL can be unavailable (old GPUs, VMs, headless GL stacks like Mesa
// llvmpipe under xvfb). If context creation fails, three.js throws out of
// the Canvas mount — with no boundary that would unmount the whole React
// root and blank the app. Catch it here so the rest of the app (open,
// slice, export) keeps working; the viewport degrades to a message.
class ViewportErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-slate-400">
          3D preview unavailable — WebGL could not be initialized
        </div>
      );
    }
    return this.props.children;
  }
}

export function Viewport({ onSceneInteractionChange, sceneInteraction }: {
  onSceneInteractionChange: (controller: SceneInteractionController | null) => void;
  sceneInteraction: SceneInteractionController | null;
}) {
  // Ref is only consumed as a prop target (drei Stats `parent`), never read
  // by this component — so it can be typed without the null union, which
  // React 19's RefObject<T> = { current: T } requires for assignability.
  const viewportRef = useRef<HTMLDivElement>(null!);
  const sceneInteractionRef = useRef<SceneInteractionController | null>(null);
  const sceneStateRef = useRef<RootState | null>(null);
  const cameraGestureActiveRef = useRef(false);
  const unsubscribeSceneInteractionRef = useRef<(() => void) | null>(null);
  const updateRaycastingEnabled = useCallback(() => {
    sceneStateRef.current?.setEvents({
      enabled: isViewportRaycastingEnabled(
        cameraGestureActiveRef.current,
        sceneInteractionRef.current?.owner ?? 'none',
      ),
    });
  }, []);
  const handleSceneInteractionChange = useCallback((controller: SceneInteractionController | null) => {
    unsubscribeSceneInteractionRef.current?.();
    unsubscribeSceneInteractionRef.current = null;
    sceneInteractionRef.current = controller;
    if (controller) {
      unsubscribeSceneInteractionRef.current = controller.subscribe(updateRaycastingEnabled);
    }
    updateRaycastingEnabled();
    onSceneInteractionChange(controller);
  }, [onSceneInteractionChange, updateRaycastingEnabled]);
  useEffect(() => () => unsubscribeSceneInteractionRef.current?.(), []);

  const setCameraGestureActive = useCallback((active: boolean) => {
    cameraGestureActiveRef.current = active;
    updateRaycastingEnabled();
  }, [updateRaycastingEnabled]);

  // Gizmo keyboard shortcuts (OrcaSlicer bindings): M / R / S toggle the move /
  // rotate / scale gizmo (like the toolbar buttons — they refuse with an empty
  // selection), Esc deselects all (which also closes the gizmo). Inputs and
  // modifier combos are ignored so shortcuts never hijack typing.
  useEffect(() => {
    if (!sceneInteraction) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        sceneInteraction.clearSelection();
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'm') sceneInteraction.toggleGizmo('move');
      else if (key === 'r') sceneInteraction.toggleGizmo('rotate');
      else if (key === 's') sceneInteraction.toggleGizmo('scale');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sceneInteraction]);

  return (
    <div
      ref={viewportRef}
      className="absolute inset-0"
      data-testid="viewport"
      onPointerDownCapture={(event) => {
        // Capture runs before three/drei target handlers. Recheck the live
        // picker here so a stale hover frame cannot start an overlapping body
        // drag before TransformControls claims its handle.
        sceneInteractionRef.current?.resolveGizmoPointerDown(event.nativeEvent);
      }}
      onPointerUpCapture={() => {
        // OrbitControls normally emits `end`, but reset here as well so a
        // released or cancelled pointer can never leave picking disabled.
        setCameraGestureActive(false);
        sceneInteractionRef.current?.releasePointer();
      }}
      onPointerCancelCapture={() => {
        setCameraGestureActive(false);
        sceneInteractionRef.current?.releasePointer();
      }}
    >
      <ViewportErrorBoundary>
        <Canvas
          events={viewportEvents}
          // Render only when something invalidates the frame (camera change,
          // scene data update, resize) — never render continuously. See
          // doc/2026-08-16-demand-render-viewport.md. OrbitControls in demand
          // mode invalidates while interacting/damping; data-driven meshes
          // invalidate via React re-render.
          frameloop="demand"
          // Slicer convention: Z up (blue), X right, Y into screen. The camera
          // is born with up = (0,0,1) — THREE.Object3D.DefaultUp is set in
          // main.tsx before the Canvas mounts, and fiber's default camera
          // lookAt(0,0,0) uses this.up — so no per-camera up wiring here.
          // OrbitControls in three r185 takes its orbit axis from camera.up.
          // position in the front (+X, -Y) octant so the initial view reads
          // the convention: X right, Y into the screen, Z up.
          camera={{ position: [200, -200, 160], fov: 45 }}
          dpr={[1, 2]}
          onCreated={(state) => {
            sceneStateRef.current = state;
            updateRaycastingEnabled();
          }}
          onPointerMissed={() => {
            sceneInteractionRef.current?.clearSelection();
          }}
        >
          <color attach="background" args={['#0f172a']} />
          {/* Perf overlay (fps/ms/memory), top-left corner of the scene.
              drei appends the DOM to document.body unless given a `parent`
              ref, and stats.js pins it inline as position:fixed — so anchor
              it to the viewport container and force absolute (the container
              is itself an absolute-positioned box). Click a panel to switch. */}
          <Stats parent={viewportRef} className="absolute!" />
          <Scene onControllerChange={handleSceneInteractionChange} />
          <OrbitControls
            makeDefault
            enableDamping
            // LEFT = orbit, RIGHT = pan, MIDDLE = zoom. Body/gizmo drags
            // (DragControls dragConfig, MoveGizmo) disable orbit for the
            // gesture's duration.
            mouseButtons={{
              LEFT: THREE.MOUSE.ROTATE,
              MIDDLE: THREE.MOUSE.DOLLY,
              RIGHT: THREE.MOUSE.PAN,
            }}
            // R3F's event manager tests every interactive mesh before it
            // dispatches a pointer event. Disable that layer for the whole
            // camera gesture so orbiting over a dense mesh remains smooth.
            onStart={() => setCameraGestureActive(true)}
            onEnd={() => setCameraGestureActive(false)}
          />
          {/* Orientation gizmo (X/Y/Z axes), bottom-left corner. GizmoHelper
              renders the gizmo into an orthographic overlay (Hud portal);
              head clicks tween the main camera to look along that axis.
              Labels are plain X/Y/Z, so no Z-up remap is needed (unlike the
              viewcube's Y-up face names). See
              doc/2026-08-17-viewcube-gizmo.md. */}
          <GizmoHelper alignment="bottom-left" margin={[80, 80]}>
            <GizmoViewport />
          </GizmoHelper>
        </Canvas>
      </ViewportErrorBoundary>
      <LayerScrubber />
      <GizmoToolbar sceneInteraction={sceneInteraction} />
    </div>
  );
}
