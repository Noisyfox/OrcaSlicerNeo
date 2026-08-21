// packages/slicer-app/src/components/viewport/Scene.tsx
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { useModelLoader } from './useModelLoader';
import { BedPlate } from './BedPlate';
import { GLVolumeMesh } from './ModelMesh';
import { useSliceResult } from './useSliceResult';
import { ToolpathLines } from './ToolpathLines';
import { TransformGizmo, type TransformGizmoMode } from './gizmo/TransformGizmo';
import { glVolumeCollection } from './GLVolume';
import { SceneInteractionController } from './SceneInteractionController';
import { SceneInteractionProvider, useSceneInteraction, useSceneInteractionVersion } from './SceneInteractionContext';

export function Scene({ onControllerChange }: {
  onControllerChange: (controller: SceneInteractionController | null) => void;
}) {
  // This controller is deliberately constructed by Scene, not App: selection
  // and pointer ownership cannot outlive a canvas remount.
  const controllerRef = useRef<SceneInteractionController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new SceneInteractionController(() => glVolumeCollection.volumes);
  }
  const controller = controllerRef.current;

  useEffect(() => {
    onControllerChange(controller);
    return () => onControllerChange(null);
  }, [controller, onControllerChange]);

  return (
    <SceneInteractionProvider controller={controller}>
      <SceneContents />
    </SceneInteractionProvider>
  );
}

function SceneContents() {
  const glVolumes = useModelLoader();
  const { toolpath } = useSliceResult();
  const sceneInteraction = useSceneInteraction();
  useSceneInteractionVersion();
  // Test-only projection hook (mock/e2e builds): Playwright needs exact
  // canvas coordinates to start an axis-arrow drag on the gizmo's shaft.
  // No-op in production builds (VITE_USE_MOCK is unset).
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  useEffect(() => {
    if (!(import.meta.env as { VITE_USE_MOCK?: string }).VITE_USE_MOCK) return;
    // The container is shared with MoveGizmo (gizmoAxis), and per-key
    // cleanup leaves a partial behind — so every key is optional here.
    const w = window as unknown as {
      __orcaE2e?: {
        projectWorldToScreen?: (p: [number, number, number]) => { x: number; y: number } | null;
        gizmoAxis?: () => string | null;
        pointerOwner?: () => 'none' | 'gizmo' | 'body';
        selectMockInstance?: (instanceIdx: number, additive?: boolean) => boolean;
      };
    };
    // Scene owns the container but shares it with MoveGizmo (gizmoAxis) —
    // merge, and remove only our own key on cleanup, so a camera/size
    // re-run does not drop the gizmo's registration.
    w.__orcaE2e = {
      ...w.__orcaE2e,
      projectWorldToScreen(p) {
        const v = new THREE.Vector3(p[0], p[1], p[2]).project(camera);
        return { x: (v.x + 1) * 0.5 * size.width, y: (1 - v.y) * 0.5 * size.height };
      },
      pointerOwner: () => sceneInteraction.owner,
      // The e2e fixture's instance collection is deterministic, while a
      // headless Electron ray at the far instance can intermittently miss
      // after the first gizmo appears. Pointer selection is still covered by
      // the first-instance and gizmo tests; this hook sets up the aggregate
      // selection for its multi-instance move assertions.
      selectMockInstance(instanceIdx, additive = true) {
        const hit = glVolumes.find((volume) => volume.buffer.instanceIdx === instanceIdx);
        return hit ? sceneInteraction.selectFromHit(hit, additive) : false;
      },
    };
    return () => {
      if (w.__orcaE2e) {
        const {
          projectWorldToScreen: _dropped,
          pointerOwner: _owner,
          selectMockInstance: _selection,
          ...rest
        } = w.__orcaE2e;
        w.__orcaE2e = rest;
      }
    };
  }, [camera, glVolumes, size, sceneInteraction]);

  // A loader replacement is a new scene even if it reuses the prior model's
  // composite IDs, so selection and the active gizmo must not leak across it.
  useEffect(() => {
    sceneInteraction.resetForModel();
  }, [glVolumes, sceneInteraction]);

  return (
    <>
      <ambientLight intensity={0.6} />
      {/* height along Z — scene is Z-up slicer convention */}
      <directionalLight position={[100, 150, 200]} intensity={1.2} />
      <BedPlate />
      {glVolumes.map((volume) => (
        <GLVolumeMesh key={volume.id} data={volume} />
      ))}
      <SelectionTransformGizmo />
      {toolpath && <ToolpathLines data={toolpath} />}
    </>
  );
}

function SelectionTransformGizmo() {
  const sceneInteraction = useSceneInteraction();
  useSceneInteractionVersion();
  const invalidate = useThree((s) => s.invalidate);
  const pivotRef = useRef<THREE.Group>(null);
  const [target, setTarget] = useState<THREE.Group | null>(null);
  const attachPivot = useCallback((group: THREE.Group | null) => {
    pivotRef.current = group;
    setTarget((current) => current === group ? current : group);
  }, []);
  const syncPivot = useCallback(() => {
    const pivot = sceneInteraction.selectionPivot();
    const group = pivotRef.current;
    if (!group || !pivot) return;
    group.position.copy(pivot);
    // Between gestures the pivot is a clean starting state: identity
    // orientation/scale, except the scale gizmo's local mode, which aligns
    // the handles to the single selected instance's axes. During an active
    // gesture TransformControls owns quaternion/scale — only position is
    // synced so the drag delta stays relative to its captured start.
    if (sceneInteraction.owner === 'none') {
      group.rotation.set(0, 0, 0);
      group.scale.set(1, 1, 1);
      if (sceneInteraction.gizmo === 'scale' && sceneInteraction.scaleSpace === 'local') {
        const orientation = sceneInteraction.selectionOrientation();
        if (orientation) group.quaternion.copy(orientation);
      }
    }
    // TransformControls reads its attached target during pointer processing;
    // make the pivot matrix current before the next drag event, not after a
    // React layout pass.
    group.updateMatrix();
    invalidate();
  }, [invalidate, sceneInteraction]);

  useLayoutEffect(() => {
    sceneInteraction.attachPivot(pivotRef.current);
    syncPivot();
    const unsubscribe = sceneInteraction.subscribe(syncPivot);
    return () => {
      unsubscribe();
      sceneInteraction.attachPivot(null);
    };
  }, [sceneInteraction, syncPivot]);

  const mode: TransformGizmoMode | null =
    sceneInteraction.gizmo === 'move' ? 'translate'
      : sceneInteraction.gizmo === 'rotate' ? 'rotate'
        : sceneInteraction.gizmo === 'scale' ? 'scale' : null;

  return (
    <>
      <group ref={attachPivot} />
      {target && mode && <TransformGizmo target={target} mode={mode} />}
    </>
  );
}
