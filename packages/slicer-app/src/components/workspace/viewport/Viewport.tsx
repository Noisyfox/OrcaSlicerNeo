// packages/slicer-app/src/components/viewport/Viewport.tsx
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import * as THREE from 'three';
import { Canvas, events as createPointerEvents, useFrame, useThree, type RootState } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport, Stats } from '@react-three/drei';
import { BED_SIZE, getPrintableAreaBounds, normalizePrintableArea, type PrintableAreaBounds } from './BedPlate';
import { Scene } from './Scene';
import { LayerScrubber } from './LayerScrubber';
import { GizmoToolbar } from './GizmoToolbar';
import { SceneContextMenu } from './SceneContextMenu';
import type { SceneInteractionController } from './SceneInteractionController';
import type { LoadedObject } from './useModelLoader';
import type { ToolpathGeometry } from './useSliceResult';
import { filterBuildPlateOccludedIntersections, pickBuildPlateId, pickTopmostModelVolume } from './buildPlatePointerOcclusion';
import { BOX_SELECT_ARM_THRESHOLD_PX } from './boxSelectionMath';
import { isViewportRaycastingEnabled } from './viewportRaycasting';
import { usePlatform } from '@orca/platform-contract';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { deleteSelection } from '../actions/deleteSelection';
import { isPrepareTab, isPreviewTab } from '../../layout/appTabs';
import { isPreviewInspectionKey, maxMoveOrderForLayer, previewKeyboardStep, previewViewportOwnsKeyboardFocus } from './previewSemantics';
import { GcodeTextWindow } from './GcodeTextWindow';
import { Button } from '@/components/ui/button';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import { applyPlateSessionTransforms } from '../actions/syncModelTransforms';
import { glVolumeCollection } from './GLVolume';
import type { PlateSessionMutationResult, PlateSessionSnapshotResult, PlateSessionSnapshot } from '@slicer/client';
import { canAddPlate, canDeletePlate } from './plateControls';

// Launch camera: look at the plate center with the plate at 45° to the screen
// plane and its X axis horizontal. The initial values use the fallback plate;
// CameraFraming below reapplies the same framing for the selected profile.
const CAMERA_DISTANCE = 450;
const CAMERA_DISTANCE_PER_BED_MM = CAMERA_DISTANCE / BED_SIZE;
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

export function Viewport({ activeTab, glVolumes, toolpath, sceneInteraction, onSceneFrameRendered }: {
  activeTab: 'prepare' | 'preview';
  glVolumes: LoadedObject[];
  toolpath: ToolpathGeometry | null;
  sceneInteraction: SceneInteractionController;
  onSceneFrameRendered?: (mode: 'prepare' | 'preview') => void;
}) {
  const platform = usePlatform();
  const plateSession = usePlateSessionStore((s) => s.snapshot);
  const setPlateSnapshot = usePlateSessionStore((s) => s.setSnapshot);
  const printableArea = useSettingsStore((s) => s.printableArea);
  const bedBounds = useMemo(
    () => getPrintableAreaBounds(normalizePrintableArea(printableArea)),
    [printableArea],
  );
  const slicing = useSlicerStore((s) => s.status === 'slicing');
  const previewTab = isPreviewTab(activeTab);
  const prepareTab = isPrepareTab(activeTab);
  const previewState = useSlicerStore((s) => s.preview);
  const setPreviewLayerEnd = useSlicerStore((s) => s.setPreviewLayerEnd);
  const setPreviewMoveEnd = useSlicerStore((s) => s.setPreviewMoveEnd);
  const setPreviewSingleLayer = useSlicerStore((s) => s.setPreviewSingleLayer);
  const [showGcodeText, setShowGcodeText] = useState(false);
  const [plateActionPending, setPlateActionPending] = useState(false);
  // Ref is only consumed as a prop target (drei Stats `parent`), never read
  // by this component — so it can be typed without the null union, which
  // React 19's RefObject<T> = { current: T } requires for assignability.
  const viewportRef = useRef<HTMLDivElement>(null!);
  const sceneInteractionRef = useRef<SceneInteractionController | null>(null);
  const sceneStateRef = useRef<RootState | null>(null);
  const cameraGestureActiveRef = useRef(false);
  const [cameraGestureActive, setCameraGestureActiveState] = useState(false);
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
  useEffect(() => {
    unsubscribeSceneInteractionRef.current?.();
    unsubscribeSceneInteractionRef.current = null;
    sceneInteractionRef.current = sceneInteraction;
    unsubscribeSceneInteractionRef.current = sceneInteraction.subscribe(updateRaycastingEnabled);
    sceneInteraction.registerBoxSelectProjector(projectWorldToViewport);
    updateRaycastingEnabled();
    return () => {
      unsubscribeSceneInteractionRef.current?.();
      unsubscribeSceneInteractionRef.current = null;
      sceneInteractionRef.current = null;
    };
  }, [projectWorldToViewport, sceneInteraction, updateRaycastingEnabled]);
  useEffect(() => {
    return () => {
      unsubscribeSceneInteractionRef.current?.();
      detachBoxSelectRef.current?.();
      boxGestureRef.current = null;
    };
  }, []);

  const setCameraGestureActive = useCallback((active: boolean) => {
    cameraGestureActiveRef.current = active;
    setCameraGestureActiveState(active);
    updateRaycastingEnabled();
  }, [updateRaycastingEnabled]);

  // Scene keyboard shortcuts (OrcaSlicer bindings): Del/Backspace delete the
  // complete objects behind the current selection, M / R / S toggle the move /
  // rotate / scale gizmo (they refuse with an empty selection), Esc deselects
  // all (which also closes the gizmo). Inputs, modifier combos and active
  // drags are ignored so shortcuts never hijack typing or a gesture.
  useEffect(() => {
    if (!sceneInteraction || previewTab) return;
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
  }, [platform.runtime, previewTab, sceneInteraction, slicing]);

  // Preview inspection shortcuts are scoped to the viewport focus and are
  // separate from Prepare's object-editing bindings above.
  useEffect(() => {
    if (!sceneInteraction || !previewTab) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!previewViewportOwnsKeyboardFocus(target, viewportRef.current, document.activeElement)) return;
      if (!isPreviewInspectionKey(event.key)) return;
      const step = previewKeyboardStep(event);
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        const delta = event.key === 'ArrowUp' ? step : -step;
        const nextLayer = Math.max(0, Math.min(useSlicerStore.getState().maxLayer, previewState.visibleLayerEnd + delta));
        setPreviewLayerEnd(nextLayer, toolpath ? maxMoveOrderForLayer(toolpath, nextLayer) : previewState.maxMove);
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const delta = event.key === 'ArrowRight' ? step : -step;
        setPreviewMoveEnd(previewState.activeMoveEnd + delta);
        return;
      }
      if (event.key.toLowerCase() === 'l') {
        event.preventDefault();
        setPreviewSingleLayer(!previewState.singleLayer);
      }
      if (event.key.toLowerCase() === 'c' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        setShowGcodeText((visible) => !visible);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewState, previewTab, sceneInteraction, setPreviewLayerEnd, setPreviewMoveEnd, setPreviewSingleLayer, toolpath]);

  const viewportPointOf = useCallback((clientX: number, clientY: number) => {
    const rect = viewportRef.current.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  const applyPlateResponse = useCallback((result: PlateSessionSnapshotResult | PlateSessionMutationResult) => {
    if (!result.ok) {
      useSlicerStore.getState().setError(result.error);
      return false;
    }
    const previous = usePlateSessionStore.getState().snapshot;
    const slicer = useSlicerStore.getState();
    const activeJob = slicer.activeSliceTarget;
    const affected = result.affectedPlateIds ?? [];
    const structural = result.dirtyReasons?.includes('plate-structure') ?? false;
    if (!structural && activeJob && affected.includes(activeJob.plateId)) {
      // The native bridge is synchronous, but worker-backed/fake runtimes can
      // still have a cancellable in-flight promise. Mark it stale first and
      // request cancellation without interrupting unrelated plates.
      slicer.invalidatePlateResults([activeJob.plateId]);
      void platform.runtime.cancel().catch(() => undefined);
    } else if (!structural && affected.length) {
      slicer.invalidatePlateResults(affected);
    }
    // Grid reflow is placement-neutral: surviving plate identities retain
    // their results. Only a deleted identity loses its session result.
    if (structural && previous) {
      const nextIds = new Set(result.plates.map((plate) => plate.plateId));
      const removed = previous.plates.filter((plate) => !nextIds.has(plate.plateId)).map((plate) => plate.plateId);
      for (const plateId of removed) slicer.discardPlateResult(plateId);
      if (activeJob && removed.includes(activeJob.plateId)) {
        slicer.invalidatePlateResults([activeJob.plateId]);
        void platform.runtime.cancel().catch(() => undefined);
      }
    }
    setPlateSnapshot(result);
    if (result.instanceTransforms) {
      applyPlateSessionTransforms({ instanceTransforms: result.instanceTransforms }, glVolumeCollection.volumes);
    }
    const revision = result.inputRevisions?.[result.currentPlateId];
    if (typeof revision === 'number' && Number.isSafeInteger(revision)) useSlicerStore.getState().activatePlateResult(result.currentPlateId, revision);
    return true;
  }, [platform.runtime, setPlateSnapshot]);

  const selectPlate = useCallback(async (plateId: string) => {
    if (plateActionPending || plateId === plateSession?.currentPlateId) return;
    setPlateActionPending(true);
    try {
      applyPlateResponse(await platform.runtime.selectPlate(plateId));
    } catch (error) {
      useSlicerStore.getState().setError(String(error));
    } finally {
      setPlateActionPending(false);
    }
  }, [applyPlateResponse, plateActionPending, platform.runtime, plateSession?.currentPlateId]);

  const addPlate = useCallback(async () => {
    if (plateActionPending || !canAddPlate(plateSession)) return;
    setPlateActionPending(true);
    try {
      const result = await platform.runtime.addPlate();
      if (applyPlateResponse(result) && result.ok) useProjectStore.getState().recordPlateMutation(result);
    } catch (error) {
      useSlicerStore.getState().setError(String(error));
    } finally {
      setPlateActionPending(false);
    }
  }, [applyPlateResponse, plateActionPending, platform.runtime, plateSession]);

  const deletePlate = useCallback(async () => {
    if (plateActionPending || !plateSession || !canDeletePlate(plateSession)) return;
    setPlateActionPending(true);
    try {
      const result = await platform.runtime.deletePlate(plateSession.currentPlateId);
      if (applyPlateResponse(result) && result.ok) useProjectStore.getState().recordPlateMutation(result);
    } catch (error) {
      useSlicerStore.getState().setError(String(error));
    } finally {
      setPlateActionPending(false);
    }
  }, [applyPlateResponse, plateActionPending, platform.runtime, plateSession]);

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

  const releaseViewportPointer = () => {
    // OrbitControls normally emits `end`, but reset here as well so a
    // released or cancelled pointer can never leave picking disabled.
    setCameraGestureActive(false);
    if (!previewTab) sceneInteractionRef.current?.releasePointer();
  };

  return (
    <div
      ref={viewportRef}
      className="absolute inset-0"
      tabIndex={0}
      aria-label={previewTab ? 'G-code preview viewport' : '3D viewport'}
      data-testid="viewport"
      onContextMenuCapture={(event) => {
        // Keep the Web canvas from exposing the browser host menu in every
        // mode. Prepare's SceneContextMenu still handles its own custom menu;
        // Preview stops propagation so no model/scene menu can open.
        event.preventDefault();
        if (previewTab) event.stopPropagation();
      }}
      onPointerDownCapture={(event) => {
        if (previewTab) {
          if ((event.target as HTMLElement | null)?.closest('canvas')) viewportRef.current.focus();
          return;
        }
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
      onPointerUpCapture={releaseViewportPointer}
      onPointerCancelCapture={releaseViewportPointer}
    >
      <ViewportErrorBoundary>
        <SceneContextMenu sceneInteraction={sceneInteraction} sceneStateRef={sceneStateRef}>
          <Canvas
            events={viewportEvents}
            // WebGL's adapter-selection hint prefers a discrete/high-
            // performance GPU when available. It is only a hint: browsers
            // retain their normal integrated-GPU/software fallback.
            gl={{ powerPreference: 'high-performance' }}
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
            // above); CameraFraming below keeps that framing in sync with the
            // active printer profile.
            // OrbitControls in three r185 takes its orbit axis from camera.up.
            camera={{ position: DEFAULT_CAMERA_POSITION, fov: 45 }}
            dpr={[1, 2]}
            onCreated={(state) => {
              sceneStateRef.current = state;
              updateRaycastingEnabled();
            }}
            onPointerMissed={(event) => {
              if (!previewTab) {
                const rect = viewportRef.current.getBoundingClientRect();
                const plateId = pickBuildPlateId(sceneStateRef.current, {
                  x: event.clientX - rect.left,
                  y: event.clientY - rect.top,
                });
                if (plateId) void selectPlate(plateId);
                else sceneInteractionRef.current?.clearSelection();
              }
            }}
          >
            <color attach="background" args={['#0f172a']} />
            {/* Perf overlay (fps/ms/memory), top-left corner of the scene.
                drei appends the DOM to document.body unless given a `parent`
                ref, and stats.js pins it inline as position:fixed — so anchor
                it to the viewport container and force absolute (the container
                is itself an absolute-positioned box). Click a panel to switch. */}
            <Stats parent={viewportRef} className="absolute!" />
            <Scene
              activeTab={activeTab}
              controller={sceneInteraction}
              glVolumes={glVolumes}
              toolpath={toolpath}
              plateSession={plateSession}
              onEmptyBedClick={selectPlate}
            />
            <ViewportFrameGate mode={activeTab} onRendered={() => onSceneFrameRendered?.(activeTab)} />
            <OrbitControls
              makeDefault
              enableDamping
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
            <CameraFraming bounds={bedBounds} />
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
      {prepareTab && <BoxSelectionOverlay sceneInteraction={sceneInteraction} />}
      {previewTab && toolpath && <LayerScrubber data={toolpath} />}
      {previewTab && toolpath && showGcodeText && <GcodeTextWindow data={toolpath} onClose={() => setShowGcodeText(false)} />}
      {prepareTab && <GizmoToolbar sceneInteraction={sceneInteraction} />}
      {prepareTab && plateSession && <PlateControls
        plateSession={plateSession}
        pending={plateActionPending}
        onAdd={addPlate}
        onDelete={deletePlate}
      />}
    </div>
  );
}

function PlateControls({
  plateSession,
  pending,
  onAdd,
  onDelete,
}: {
  plateSession: PlateSessionSnapshot;
  pending: boolean;
  onAdd: () => void;
  onDelete: () => void;
}) {
  const current = plateSession.plates.find((plate) => plate.plateId === plateSession.currentPlateId);
  return (
    <div className="absolute bottom-2 right-2 z-20 flex items-center gap-2 rounded-md border bg-background/90 p-1.5 shadow-sm backdrop-blur" data-testid="plate-controls">
      <span className="px-1 text-xs text-muted-foreground" data-testid="current-plate-label">
        {current?.name ?? 'Plate'} ({plateSession.plates.length}/36)
      </span>
      <Button size="xs" variant="secondary" onClick={onAdd} disabled={pending || !canAddPlate(plateSession)} data-testid="add-plate">
        Add plate
      </Button>
      <Button size="xs" variant="outline" onClick={onDelete} disabled={pending || !canDeletePlate(plateSession)} data-testid="delete-plate">
        Delete plate
      </Button>
    </div>
  );
}

/** Keep the initial view centered and scaled to the active printer profile. */
function CameraFraming({ bounds }: { bounds: PrintableAreaBounds }) {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls as unknown as {
    target: THREE.Vector3;
    update: () => void;
  } | undefined);

  useEffect(() => {
    const distance = Math.max(300, Math.max(bounds.width, bounds.depth) * CAMERA_DISTANCE_PER_BED_MM);
    const target = new THREE.Vector3(bounds.centerX, bounds.centerY, 0);
    camera.position.set(
      bounds.centerX,
      bounds.centerY - distance / Math.SQRT2,
      distance / Math.SQRT2,
    );
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    if (controls) {
      controls.target.copy(target);
      controls.update();
    }
  }, [bounds, camera, controls]);

  return null;
}

/** Notify Workspace after the current Prepare/Preview scene reaches the render loop. */
function ViewportFrameGate({ mode, onRendered }: {
  mode: 'prepare' | 'preview';
  onRendered: () => void;
}) {
  const renderedModeRef = useRef<typeof mode | null>(null);
  useFrame(() => {
    if (renderedModeRef.current === mode) return;
    renderedModeRef.current = mode;
    onRendered();
  });
  return null;
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

