// packages/slicer-app/src/components/viewport/Viewport.tsx
import { Component, useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import * as THREE from 'three';
import { Canvas, events as createPointerEvents, type RootState } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport, Stats } from '@react-three/drei';
import { BED_SIZE } from './BedPlate';
import { Scene } from './Scene';
import { LayerScrubber } from './LayerScrubber';
import { GizmoToolbar } from './GizmoToolbar';
import { SceneContextMenu } from './SceneContextMenu';
import type { SceneInteractionController } from './SceneInteractionController';
import { filterBuildPlateOccludedIntersections, MODEL_BODY_RAYCAST } from './buildPlatePointerOcclusion';
import { BOX_SELECT_ARM_THRESHOLD_PX } from './boxSelectionMath';
import type { GLVolume } from './GLVolume';
import { isViewportRaycastingEnabled } from './viewportRaycasting';
import { usePlatform } from '@orca/platform-contract';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { deleteSelection } from '../toolbar/deleteSelection';

// Launch camera: look at the plate center (the bed spans [0, BED_SIZE]² in
// XY with Z up), with the plate at 45° to the screen plane and its X axis
// horizontal. For the plate plane (XY, normal Z) to make 45° with the screen
// plane, the view direction sits at 45° elevation — f ∝ (0, 1, -1) from the
// front −Y octant — and with camera up = Z the screen-right vector is
// f × up ∝ (1, 0, 0), so X is exactly horizontal and points right.
const CAMERA_TARGET: [number, number, number] = [BED_SIZE / 2, BED_SIZE / 2, 0];
const CAMERA_DISTANCE = 450;
const DEFAULT_CAMERA_POSITION: [number, number, number] = [
  BED_SIZE / 2,
  BED_SIZE / 2 - CAMERA_DISTANCE / Math.SQRT2,
  CAMERA_DISTANCE / Math.SQRT2,
];

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
  const platform = usePlatform();
  const slicing = useSlicerStore((s) => s.status === 'slicing');
  // Ref is only consumed as a prop target (drei Stats `parent`), never read
  // by this component — so it can be typed without the null union, which
  // React 19's RefObject<T> = { current: T } requires for assignability.
  const viewportRef = useRef<HTMLDivElement>(null!);
  const sceneInteractionRef = useRef<SceneInteractionController | null>(null);
  const sceneStateRef = useRef<RootState | null>(null);
  const cameraGestureActiveRef = useRef(false);
  const unsubscribeSceneInteractionRef = useRef<(() => void) | null>(null);
  const boxGestureRef = useRef<{
    pointerId: number;
    start: { x: number; y: number };
    additive: boolean;
    armed: boolean;
  } | null>(null);
  const detachBoxSelectRef = useRef<(() => void) | null>(null);
  const updateRaycastingEnabled = useCallback(() => {
    sceneStateRef.current?.setEvents({
      enabled: isViewportRaycastingEnabled(
        cameraGestureActiveRef.current,
        sceneInteractionRef.current?.owner ?? 'none',
      ),
    });
  }, []);
  const projectWorldToViewport = useCallback((world: THREE.Vector3) => {
    const state = sceneStateRef.current;
    if (!state) return null;
    const projected = world.clone().project(state.camera);
    // Corners behind the near plane project with flipped coordinates; skip
    // them so a box that wraps around the camera cannot select phantom areas.
    if (projected.z < -1 || projected.z > 1) return null;
    return {
      x: (projected.x + 1) * 0.5 * state.size.width,
      y: (1 - projected.y) * 0.5 * state.size.height,
    };
  }, []);
  const handleSceneInteractionChange = useCallback((controller: SceneInteractionController | null) => {
    unsubscribeSceneInteractionRef.current?.();
    unsubscribeSceneInteractionRef.current = null;
    sceneInteractionRef.current = controller;
    if (controller) {
      unsubscribeSceneInteractionRef.current = controller.subscribe(updateRaycastingEnabled);
      controller.registerBoxSelectProjector(projectWorldToViewport);
    }
    updateRaycastingEnabled();
    onSceneInteractionChange(controller);
  }, [onSceneInteractionChange, projectWorldToViewport, updateRaycastingEnabled]);
  useEffect(() => {
    return () => {
      unsubscribeSceneInteractionRef.current?.();
      detachBoxSelectRef.current?.();
      boxGestureRef.current = null;
    };
  }, []);

  const setCameraGestureActive = useCallback((active: boolean) => {
    cameraGestureActiveRef.current = active;
    updateRaycastingEnabled();
  }, [updateRaycastingEnabled]);

  // Scene keyboard shortcuts (OrcaSlicer bindings): Del/Backspace delete the
  // complete objects behind the current selection, M / R / S toggle the move /
  // rotate / scale gizmo (they refuse with an empty selection), Esc deselects
  // all (which also closes the gizmo). Inputs, modifier combos and active
  // drags are ignored so shortcuts never hijack typing or a gesture.
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
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (slicing || sceneInteraction.owner !== 'none') return;
        if (sceneInteraction.selectedObjectIndices().length === 0) return;
        event.preventDefault();
        void deleteSelection(platform.runtime, sceneInteraction);
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'm') sceneInteraction.toggleGizmo('move');
      else if (key === 'r') sceneInteraction.toggleGizmo('rotate');
      else if (key === 's') sceneInteraction.toggleGizmo('scale');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [platform.runtime, sceneInteraction, slicing]);

  const viewportPointOf = useCallback((clientX: number, clientY: number) => {
    const rect = viewportRef.current.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  const canStartBoxSelect = useCallback((event: PointerEvent, grabbedGizmo: boolean): boolean => {
    if (event.button !== 0 || !event.shiftKey || grabbedGizmo) return false;
    // Only canvas presses start a marquee — overlay DOM (toolbar, scrubber,
    // stats) keeps its own pointer behavior even while Shift is held.
    const dom = sceneStateRef.current?.gl.domElement;
    if (!dom) return false;
    const target = event.target as Node | null;
    return target !== null && (target === dom || dom.contains(target));
  }, []);

  const detachBoxSelectListeners = () => {
    window.removeEventListener('pointermove', onWindowBoxPointerMove, true);
    window.removeEventListener('pointerup', onWindowBoxPointerUp, true);
    window.removeEventListener('pointercancel', onWindowBoxPointerCancel, true);
    window.removeEventListener('blur', onWindowBoxBlur);
    detachBoxSelectRef.current = null;
  };

  const startBoxSelectGesture = (event: PointerEvent) => {
    boxGestureRef.current = {
      pointerId: event.pointerId,
      start: viewportPointOf(event.clientX, event.clientY),
      additive: event.ctrlKey || event.metaKey,
      armed: false,
    };
    detachBoxSelectRef.current = detachBoxSelectListeners;
    window.addEventListener('pointermove', onWindowBoxPointerMove, true);
    window.addEventListener('pointerup', onWindowBoxPointerUp, true);
    window.addEventListener('pointercancel', onWindowBoxPointerCancel, true);
    window.addEventListener('blur', onWindowBoxBlur);
  };

  const onWindowBoxPointerMove = (event: PointerEvent) => {
    const gesture = boxGestureRef.current;
    const controller = sceneInteractionRef.current;
    if (!gesture || !controller || event.pointerId !== gesture.pointerId) return;
    const point = viewportPointOf(event.clientX, event.clientY);
    if (!gesture.armed) {
      const dx = point.x - gesture.start.x;
      const dy = point.y - gesture.start.y;
      if (dx * dx + dy * dy <= BOX_SELECT_ARM_THRESHOLD_PX * BOX_SELECT_ARM_THRESHOLD_PX) return;
      if (!controller.beginBoxSelect(gesture.start, gesture.additive)) {
        boxGestureRef.current = null;
        detachBoxSelectListeners();
        return;
      }
      gesture.armed = true;
    }
    controller.updateBoxSelect(point);
    event.preventDefault();
  };

  const onWindowBoxPointerUp = (event: PointerEvent) => {
    const gesture = boxGestureRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    boxGestureRef.current = null;
    detachBoxSelectListeners();
    const controller = sceneInteractionRef.current;
    if (!controller) return;
    if (gesture.armed) {
      controller.endBoxSelect();
    } else {
      // Shift without a drag is a click: mirror the normal click path so
      // Shift+click keeps today's behavior (select the body, clear on empty).
      const volume = pickTopmostModelVolume(sceneStateRef.current, gesture.start);
      if (volume) controller.selectFromClick(volume, gesture.additive);
      else controller.clearSelection();
    }
    controller.releasePointer();
    setCameraGestureActive(false);
  };

  const onWindowBoxPointerCancel = (event: PointerEvent) => {
    const gesture = boxGestureRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    boxGestureRef.current = null;
    detachBoxSelectListeners();
    sceneInteractionRef.current?.cancelBoxSelect();
    setCameraGestureActive(false);
  };

  const onWindowBoxBlur = () => {
    if (!boxGestureRef.current) return;
    boxGestureRef.current = null;
    detachBoxSelectListeners();
    sceneInteractionRef.current?.cancelBoxSelect();
  };

  return (
    <div
      ref={viewportRef}
      className="absolute inset-0"
      data-testid="viewport"
      onPointerDownCapture={(event) => {
        const native = event.nativeEvent;
        // Capture runs before three/drei target handlers. Recheck the live
        // picker here so a stale hover frame cannot start an overlapping body
        // drag before TransformControls claims its handle.
        const grabbedGizmo = sceneInteractionRef.current?.resolveGizmoPointerDown(native) ?? false;
        // Shift+drag is box selection: claim the press before OrbitControls
        // or DragControls can start their own gesture. A gizmo grab keeps
        // strict priority, and overlay DOM is never hijacked.
        if (canStartBoxSelect(native, grabbedGizmo)) {
          startBoxSelectGesture(native);
          native.stopImmediatePropagation();
          native.preventDefault();
        }
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
        <SceneContextMenu sceneInteraction={sceneInteraction} sceneStateRef={sceneStateRef}>
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
            // main.tsx before the Canvas mounts — so no per-camera up wiring
            // here. The launch view looks at the plate center with X horizontal
            // and the plate at 45° to the screen plane (DEFAULT_CAMERA_POSITION
            // above); the OrbitControls target below keeps that framing.
            // OrbitControls in three r185 takes its orbit axis from camera.up.
            camera={{ position: DEFAULT_CAMERA_POSITION, fov: 45 }}
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
              target={CAMERA_TARGET}
              // LEFT = orbit, MIDDLE = pan, RIGHT = pan, wheel = zoom — the
              // upstream OrcaSlicer drag defaults (see AppConfig.cpp
              // `*_mouse_drag_action`). Body/gizmo drags (DragControls
              // dragConfig, MoveGizmo) disable orbit for the gesture's
              // duration.
              mouseButtons={{
                LEFT: THREE.MOUSE.ROTATE,
                MIDDLE: THREE.MOUSE.PAN,
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
        </SceneContextMenu>
      </ViewportErrorBoundary>
      <BoxSelectionOverlay sceneInteraction={sceneInteraction} />
      <LayerScrubber />
      <GizmoToolbar sceneInteraction={sceneInteraction} />
    </div>
  );
}

/** The screen-space marquee rendered while a Shift+drag box selection is live. */
function BoxSelectionOverlay({ sceneInteraction }: {
  sceneInteraction: SceneInteractionController | null;
}) {
  const [rect, setRect] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  useEffect(() => {
    if (!sceneInteraction) {
      setRect(null);
      return;
    }
    const sync = () => setRect(sceneInteraction.boxSelectionRect);
    sync();
    return sceneInteraction.subscribe(sync);
  }, [sceneInteraction]);
  if (!rect) return null;
  return (
    <div
      data-testid="box-select-marquee"
      className="pointer-events-none absolute z-10 border border-sky-400/80 bg-sky-400/10"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    />
  );
}

/** The topmost visible model body under a viewport-CSS point, or null. */
function pickTopmostModelVolume(
  state: RootState | null,
  point: { x: number; y: number },
): GLVolume | null {
  if (!state) return null;
  const rect = state.gl.domElement.getBoundingClientRect();
  const nx = (point.x / rect.width) * 2 - 1;
  const ny = -((point.y / rect.height) * 2) + 1;
  if (nx < -1 || nx > 1 || ny < -1 || ny > 1) return null;
  state.raycaster.setFromCamera(new THREE.Vector2(nx, ny), state.camera);
  const hits = filterBuildPlateOccludedIntersections(
    state.raycaster.intersectObjects(state.scene.children, true),
  );
  const hit = hits.find(
    (h) => (h.object.userData as { orcaRaycastRole?: string }).orcaRaycastRole === MODEL_BODY_RAYCAST,
  );
  return (hit?.object.userData as { orcaVolume?: GLVolume } | undefined)?.orcaVolume ?? null;
}
