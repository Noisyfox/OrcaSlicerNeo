// packages/slicer-app/src/components/viewport/Scene.tsx
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import type { LoadedObject } from './useModelLoader';
import { BedPlate } from './BedPlate';
import { GLVolumeMesh } from './ModelMesh';
import type { ToolpathGeometry } from './useSliceResult';
import { ToolpathLines } from './ToolpathLines';
import { ToolpathMarker } from './ToolpathMarker';
import { TransformGizmo, type TransformGizmoMode } from './gizmo/TransformGizmo';
import { SceneInteractionController } from './SceneInteractionController';
import { SceneInteractionProvider, useSceneInteraction, useSceneInteractionVersion } from './SceneInteractionContext';
import { SelectionBoundsBox } from './SelectionBoundsBox';
import { hasEnteredPreview, isPreviewTab } from '../../layout/appTabs';
import type { PlateSessionSnapshot } from '@slicer/client';
import { BUILD_PLATE_RAYCAST } from './buildPlatePointerOcclusion';

export function Scene({ activeTab, controller, glVolumes, toolpath, plateSession, onEmptyBedClick }: {
  activeTab: 'prepare' | 'preview';
  controller: SceneInteractionController;
  glVolumes: LoadedObject[];
  toolpath: ToolpathGeometry | null;
  plateSession?: PlateSessionSnapshot | null;
  onEmptyBedClick?: (plateId: string) => void;
}) {
  return (
    <SceneInteractionProvider controller={controller}>
      <SceneContents activeTab={activeTab} glVolumes={glVolumes} toolpath={toolpath} plateSession={plateSession} onEmptyBedClick={onEmptyBedClick} />
    </SceneInteractionProvider>
  );
}

function SceneContents({ activeTab, glVolumes, toolpath, plateSession, onEmptyBedClick }: {
  activeTab: 'prepare' | 'preview';
  glVolumes: LoadedObject[];
  toolpath: ToolpathGeometry | null;
  plateSession?: PlateSessionSnapshot | null;
  onEmptyBedClick?: (plateId: string) => void;
}) {
  const sceneInteraction = useSceneInteraction();
  useSceneInteractionVersion();
  const previousActiveTabRef = useRef<'prepare' | 'preview' | null>(null);
  useEffect(() => {
    if (hasEnteredPreview(previousActiveTabRef.current, activeTab)) {
      // Preview retains the shared selection for sidebar use, but never an
      // armed viewport gizmo. Prepare will render that selection again.
      sceneInteraction.closeGizmo();
    }
    previousActiveTabRef.current = activeTab;
  }, [activeTab, sceneInteraction]);
  // Test-only projection hook (e2e builds): Playwright needs exact
  // canvas coordinates to start an axis-arrow drag on the gizmo's shaft.
  // No-op in production builds (the e2e-only VITE_E2E flag is unset).
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls as unknown as { target?: THREE.Vector3 } | undefined);
  const scene = useThree((s) => s.scene);
  const size = useThree((s) => s.size);
  useEffect(() => {
    const env = import.meta.env as { MODE?: string; VITE_E2E?: string };
    if (env.MODE !== 'e2e' && env.VITE_E2E !== '1') return;
    // The container is shared with TransformGizmo (gizmoAxis), and per-key
    // cleanup leaves a partial behind — so every key is optional here.
    const w = window as unknown as {
      __orcaE2e?: {
        projectWorldToScreen?: (p: [number, number, number]) => { x: number; y: number } | null;
        projectSelectionPivot?: () => { x: number; y: number } | null;
        selectionPivotWorld?: () => [number, number, number] | null;
        selectionBoundsWorld?: () => {
          min: [number, number, number];
          max: [number, number, number];
          center: [number, number, number];
          size: [number, number, number];
        } | null;
        gizmoAxis?: () => string | null;
        pointerOwner?: () => 'none' | 'gizmo' | 'body' | 'box';
        selectionInstanceCount?: () => number;
        selectMockInstance?: (instanceIdx: number, additive?: boolean) => boolean;
        previewMarkerPresent?: () => boolean;
        cameraState?: () => { position: [number, number, number]; target: [number, number, number] };
        bedPlateStates?: () => Array<{
          plateId?: string;
          current: boolean;
          outOfBounds: boolean;
          position: [number, number, number];
        }>;
        modelWorldCenters?: () => Array<[number, number, number]>;
      };
    };
    const projectPoint = (p: THREE.Vector3) => {
      const v = p.clone().project(camera);
      return { x: (v.x + 1) * 0.5 * size.width, y: (1 - v.y) * 0.5 * size.height };
    };
    // Scene owns the container but shares it with TransformGizmo (gizmoAxis) —
    // merge, and remove only our own key on cleanup, so a camera/size
    // re-run does not drop the gizmo's registration.
    w.__orcaE2e = {
      ...w.__orcaE2e,
      projectWorldToScreen(p) {
        return projectPoint(new THREE.Vector3(p[0], p[1], p[2]));
      },
      // The gizmo pivots at the CURRENT selection bounds center — after scale
      // edits the anchor can move relative to a fixed world point, so the e2e
      // aims at the live pivot.
      projectSelectionPivot() {
        const pivot = sceneInteraction.selectionPivot();
        return pivot ? projectPoint(pivot) : null;
      },
      selectionPivotWorld() {
        const pivot = sceneInteraction.selectionPivot();
        return pivot ? [pivot.x, pivot.y, pivot.z] : null;
      },
      selectionBoundsWorld() {
        const bounds = sceneInteraction.selectionBounds();
        if (!bounds) return null;
        const min = bounds.min;
        const max = bounds.max;
        const size = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        return {
          min: [min.x, min.y, min.z],
          max: [max.x, max.y, max.z],
          center: [center.x, center.y, center.z],
          size: [size.x, size.y, size.z],
        };
      },
      pointerOwner: () => sceneInteraction.owner,
      selectionInstanceCount: () => sceneInteraction.selectionInstanceCount,
      // The e2e fixture's instance collection is deterministic, while a
      // headless Electron ray at the far instance can intermittently miss
      // after the first gizmo appears. Pointer selection is still covered by
      // the first-instance and gizmo tests; this hook sets up the aggregate
      // selection for its multi-instance move assertions.
      selectMockInstance(instanceIdx, additive = true) {
        const hit = glVolumes.find((volume) => volume.buffer.instanceIdx === instanceIdx);
        // sceneInteraction is null until the viewport mounts; fail the poll
        // (false) rather than throwing so the e2e hook is retryable.
        return hit && sceneInteraction ? sceneInteraction.selectFromHit(hit, additive) : false;
      },
      previewMarkerPresent: () => Boolean(scene.getObjectByName('preview-nozzle-marker')),
      cameraState: () => ({
        position: [camera.position.x, camera.position.y, camera.position.z],
        target: controls?.target ? [controls.target.x, controls.target.y, controls.target.z] : [0, 0, 0],
      }),
      bedPlateStates: () => {
        const beds: Array<{
          plateId?: string;
          current: boolean;
          outOfBounds: boolean;
          position: [number, number, number];
        }> = [];
        scene.traverse((object) => {
          if (object.userData.orcaRaycastRole !== BUILD_PLATE_RAYCAST) return;
          const position = new THREE.Vector3();
          object.getWorldPosition(position);
          beds.push({
            plateId: object.userData.plateId as string | undefined,
            current: Boolean(object.userData.plateCurrent),
            outOfBounds: Boolean(object.userData.plateOutOfBounds),
            position: [position.x, position.y, position.z],
          });
        });
        return beds;
      },
      modelWorldCenters: () => glVolumes.map((volume) => {
        const center = volume.getWorldBounds().getCenter(new THREE.Vector3());
        return [center.x, center.y, center.z];
      }),
    };
    return () => {
      if (w.__orcaE2e) {
        const {
          projectWorldToScreen: _dropped,
          projectSelectionPivot: _pivot,
          selectionPivotWorld: _pivotWorld,
          selectionBoundsWorld: _bounds,
          pointerOwner: _owner,
          selectionInstanceCount: _count,
          selectMockInstance: _selection,
          previewMarkerPresent: _marker,
          cameraState: _camera,
          bedPlateStates: _beds,
          modelWorldCenters: _models,
          ...rest
        } = w.__orcaE2e;
        w.__orcaE2e = rest;
      }
    };
  }, [camera, controls, glVolumes, scene, size, sceneInteraction]);

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
      {!isPreviewTab(activeTab) && plateSession?.plates?.length
        ? plateSession.plates.map((plate) => (
          <BedPlate
            key={plate.plateId}
            plate={plate}
            current={plate.plateId === plateSession.currentPlateId}
            onEmptyBedClick={onEmptyBedClick}
          />
        ))
        : <BedPlate />}
      {isPreviewTab(activeTab) ? (
        <PreviewScene glVolumes={glVolumes} toolpath={toolpath} />
      ) : (
        <PrepareScene glVolumes={glVolumes} toolpath={toolpath} />
      )}
    </>
  );
}

/**
 * Explicit content-tree seams for the two Workspace modes. The trees share
 * the persistent Canvas, camera, controller, loaded volumes and toolpath;
 * mode-specific rendering/interaction policy is intentionally layered here
 * by the later Preview implementation step.
 */
function PrepareScene({ glVolumes, toolpath }: {
  glVolumes: LoadedObject[];
  toolpath: ToolpathGeometry | null;
}) {
  return <SceneContentTree glVolumes={glVolumes} toolpath={null} interactive />;
}

function PreviewScene({ glVolumes, toolpath }: {
  glVolumes: LoadedObject[];
  toolpath: ToolpathGeometry | null;
}) {
  return <SceneContentTree glVolumes={glVolumes} toolpath={toolpath} interactive={false} preview />;
}

function SceneContentTree({ glVolumes, toolpath, interactive, preview = false }: {
  glVolumes: LoadedObject[];
  toolpath: ToolpathGeometry | null;
  interactive: boolean;
  preview?: boolean;
}) {
  return (
    <>
      {glVolumes.map((volume) => (
        <GLVolumeMesh key={volume.id} data={volume} interactive={interactive} preview={preview} />
      ))}
      {interactive && <SelectionBoundsBox />}
      {interactive && <SelectionTransformGizmo />}
      {toolpath && <ToolpathLines data={toolpath} />}
      {toolpath && <ToolpathMarker data={toolpath} />}
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
