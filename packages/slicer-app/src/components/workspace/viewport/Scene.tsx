// packages/slicer-app/src/components/viewport/Scene.tsx
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import type { LoadedObject } from './useModelLoader';
import { glVolumeCollection } from './GLVolume';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import { BedPlate, getPrintableAreaBounds, normalizePrintableArea } from './BedPlate';
import { GLVolumeMesh } from './ModelMesh';
import type { ToolpathGeometry } from './useSliceResult';
import { ToolpathLines } from './ToolpathLines';
import { ToolpathMarker } from './ToolpathMarker';
import { TransformGizmo, type TransformGizmoMode } from './gizmo/TransformGizmo';
import { SceneInteractionController } from './SceneInteractionController';
import { SceneInteractionProvider, useSceneInteraction, useSceneInteractionVersion } from './SceneInteractionContext';
import { SelectionBoundsBox } from './SelectionBoundsBox';
import { hasEnteredPreview, isPreviewTab } from '../../layout/appTabs';
import type { ModelObjectStructure, PlateSessionSnapshot } from '@slicer/client';
import { BUILD_PLATE_RAYCAST, MODEL_BODY_RAYCAST } from './buildPlatePointerOcclusion';
import { currentPreviewPlate, previewVolumesForCurrentPlate } from './previewSceneProjection';
import { WipeTowerVolumes } from './WipeTowerVolumeMesh';
import type { WipeTowerVolumeCollection } from './WipeTowerVolume';

export function Scene({ activeTab, controller, wipeTowerVolumes, glVolumes, toolpath, plateSession, structure = [], onEmptyBedClick }: {
  activeTab: 'prepare' | 'preview';
  controller: SceneInteractionController;
  wipeTowerVolumes?: WipeTowerVolumeCollection;
  glVolumes: LoadedObject[];
  toolpath: ToolpathGeometry | null;
  plateSession?: PlateSessionSnapshot | null;
  structure?: readonly ModelObjectStructure[];
  onEmptyBedClick?: (plateId: string) => void;
}) {
  return (
    <SceneInteractionProvider controller={controller}>
      <SceneContents activeTab={activeTab} controller={controller} wipeTowerVolumes={wipeTowerVolumes} glVolumes={glVolumes} toolpath={toolpath} plateSession={plateSession} structure={structure} onEmptyBedClick={onEmptyBedClick} />
    </SceneInteractionProvider>
  );
}

function SceneContents({ activeTab, controller, wipeTowerVolumes, glVolumes, toolpath, plateSession, structure = [], onEmptyBedClick }: {
  activeTab: 'prepare' | 'preview';
  controller: SceneInteractionController;
  wipeTowerVolumes?: WipeTowerVolumeCollection;
  glVolumes: LoadedObject[];
  toolpath: ToolpathGeometry | null;
  plateSession?: PlateSessionSnapshot | null;
  structure?: readonly ModelObjectStructure[];
  onEmptyBedClick?: (plateId: string) => void;
}) {
  const sceneInteraction = useSceneInteraction();
  const previewVolumes = useMemo(
    () => isPreviewTab(activeTab) ? previewVolumesForCurrentPlate(glVolumes, plateSession) : glVolumes,
    [activeTab, glVolumes, plateSession],
  );
  const previousActiveTabRef = useRef<'prepare' | 'preview' | null>(null);
  useEffect(() => {
    if (hasEnteredPreview(previousActiveTabRef.current, activeTab)) {
      // Preview retains the shared selection for sidebar use, but never an
      // armed viewport gizmo. Prepare will render that selection again.
      sceneInteraction.closeGizmo();
    }
    previousActiveTabRef.current = activeTab;
  }, [activeTab, sceneInteraction]);
  // A loader replacement is a new scene even if it reuses the prior model's
  // composite IDs. Clear interaction state before publishing any e2e helper
  // for the new collection; otherwise a polling selection can land between
  // the helper effect and this reset and be cleared immediately afterwards.
  useEffect(() => {
    // A Prime Tower move can republish model meshes while its native commit
    // is still in flight. The tower keeps its stable selection ID across that
    // receipt; prune against the current collection instead of clearing it.
    if (wipeTowerVolumes?.busy) sceneInteraction.pruneSelection();
    else sceneInteraction.resetForModel();
  }, [glVolumes, sceneInteraction, wipeTowerVolumes]);
  // Test-only projection hook (e2e builds): Playwright needs exact
  // canvas coordinates to start an axis-arrow drag on the gizmo's shaft.
  // No-op in production builds (the e2e-only VITE_E2E flag is unset).
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls as unknown as { target?: THREE.Vector3; enabled?: boolean } | undefined);
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
        pointerOwner?: () => 'none' | 'gizmo' | 'body' | 'box' | 'external';
        selectionInstanceCount?: () => number;
        selectMockInstance?: (instanceIdx: number, additive?: boolean) => boolean;
        previewMarkerPresent?: () => boolean;
        cameraState?: () => {
          position: [number, number, number];
          target: [number, number, number];
          near: number;
          far: number;
          controlsEnabled?: boolean;
        };
        bedPlateStates?: () => Array<{
          plateId?: string;
          current: boolean;
          outOfBounds: boolean;
          position: [number, number, number];
          bounds: { minX: number; maxX: number; minY: number; maxY: number };
        }>;
        modelWorldCenters?: () => Array<[number, number, number]>;
        modelMaterialColours?: () => Array<{ objectIndex: number; volumeIndex: number; colour: string }>;
        previewToolpathWorldBounds?: () => {
          min: [number, number, number];
          max: [number, number, number];
        } | null;
        realProjectRendererMemorySnapshot?: () => {
          identity: 'ORCA_REAL_PROJECT_PROFILE_RENDERER_V1';
          reactTypedArrayBytes: number;
          gpuProjectionEstimatedBytes: number;
          volumeCount: number;
          perPlate: Array<{
            plateId: string;
            reactTypedArrayBytes: number;
            gpuProjectionEstimatedBytes: number;
            volumeCount: number;
          }>;
        };
        realProjectModelWorldCentersProfile?: () => {
          identity: 'ORCA_REAL_PROJECT_BOUNDS_PROFILE_V1';
          durationMs: number;
          centers: Array<[number, number, number]>;
        };
        realProjectPlateModelWorldCenters?: (plateId: string) => Array<[number, number, number]>;
        realProjectSelectFirstModelOnPlate?: (plateId: string) => boolean;
        realProjectMoveSelectedX?: (delta: number) => { moved: boolean; startedAt: number };
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
        // modelLoaded flips before the asynchronous mesh publication, so an
        // e2e poll must not select a volume from the previous collection.
        // The collection revision can be published a few instructions before
        // React commits the matching `glVolumes` state. Require revision and
        // element identity as well, so a poll cannot select through that
        // publication window. `useModelLoader` deliberately exposes a fresh
        // array snapshot, so comparing the array object itself would reject
        // every valid snapshot even when all published GLVolume identities
        // match.
        // A mutation can publish its new collection before its history
        // transaction finishes the final scene reset. Do not let this test
        // helper select into that short publication window.
        if (useProjectStore.getState().projectMutationPendingCount !== 0
          || glVolumeCollection.revision !== useSettingsStore.getState().modelRevision
          || glVolumeCollection.volumes.length !== glVolumes.length
          || glVolumeCollection.volumes.some((volume, index) => volume !== glVolumes[index])) return false;
        const hit = glVolumes.find((volume) => volume.buffer.instanceIdx === instanceIdx);
        // sceneInteraction is null until the viewport mounts; fail the poll
        // (false) rather than throwing so the e2e hook is retryable.
        return Boolean(hit && sceneInteraction && sceneInteraction.selectFromHit(hit, additive));
      },
      previewMarkerPresent: () => Boolean(scene.getObjectByName('preview-nozzle-marker')),
      cameraState: () => ({
        position: [camera.position.x, camera.position.y, camera.position.z],
        target: controls?.target ? [controls.target.x, controls.target.y, controls.target.z] : [0, 0, 0],
        near: camera.near,
        far: camera.far,
        controlsEnabled: controls?.enabled !== false,
      }),
      bedPlateStates: () => {
        const printableBounds = getPrintableAreaBounds(normalizePrintableArea(useSettingsStore.getState().printableArea));
        const beds: Array<{
          plateId?: string;
          current: boolean;
          outOfBounds: boolean;
          position: [number, number, number];
          bounds: { minX: number; maxX: number; minY: number; maxY: number };
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
            bounds: {
              minX: printableBounds.minX,
              maxX: printableBounds.maxX,
              minY: printableBounds.minY,
              maxY: printableBounds.maxY,
            },
          });
        });
        return beds;
      },
      modelWorldCenters: () => previewVolumes.map((volume) => {
        const center = volume.getWorldBounds().getCenter(new THREE.Vector3());
        return [center.x, center.y, center.z];
      }),
      modelMaterialColours: () => {
        const colours: Array<{ objectIndex: number; volumeIndex: number; colour: string }> = [];
        if (activeTab !== 'prepare') return colours;
        scene.traverse((object) => {
          if (object.userData.orcaRaycastRole !== MODEL_BODY_RAYCAST) return;
          const volume = object.userData.orcaVolume as LoadedObject | undefined;
          const mesh = object.getObjectByProperty('type', 'Mesh') as THREE.Mesh | undefined;
          const material = mesh?.material;
          if (!volume || !(material instanceof THREE.MeshStandardMaterial)) return;
          colours.push({
            objectIndex: volume.buffer.objectIdx,
            volumeIndex: volume.buffer.volumeIdx,
            colour: `#${material.color.getHexString()}`,
          });
        });
        return colours;
      },
      previewToolpathWorldBounds: () => {
        if (!toolpath || toolpath.segmentCount === 0) return null;
        const min: [number, number, number] = [Infinity, Infinity, Infinity];
        const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
        const include = (values: Float32Array, index: number) => {
          for (let axis = 0; axis < 3; axis++) {
            const value = values[index * 3 + axis];
            if (!Number.isFinite(value)) continue;
            min[axis] = Math.min(min[axis], value);
            max[axis] = Math.max(max[axis], value);
          }
        };
        for (let index = 0; index < toolpath.segmentCount; index++) {
          // Only extrusion segments are part of the printed geometry. Travel
          // and startup/control moves may legitimately park outside a bed and
          // would make a plate-placement assertion about the printed path
          // meaningless.
          if (toolpath.moveTypes[index] !== 10) continue;
          include(toolpath.source?.ends ?? toolpath.ends, index);
          // GCodeProcessor intentionally begins with a dummy move at (0, 0,
          // 0).  The first segment's start is that sentinel, not a rendered
          // printer move; including it would falsely make every non-first
          // plate appear to reach plate 1 in this diagnostic.
          if (index > 0 && toolpath.source?.starts) include(toolpath.source.starts, index);
        }
        return {
          min: [min[0], min[1], min[2]],
          max: [max[0], max[1], max[2]],
        };
      },
      ...(import.meta.env.VITE_REAL_PROJECT_PROFILE === '1' ? {
        realProjectPlateModelWorldCenters: (plateId: string) => {
          const instancePlates = new Map((plateSession?.instances ?? []).map((instance) =>
            [`${instance.objectIndex}:${instance.instanceIndex}`, instance.plateId]));
          return glVolumes.filter((volume) =>
            instancePlates.get(`${volume.buffer.objectIdx}:${volume.buffer.instanceIdx}`) === plateId)
            .map((volume) => {
              const center = volume.getWorldBounds().getCenter(new THREE.Vector3());
              return [center.x, center.y, center.z] as [number, number, number];
            });
        },
        realProjectSelectFirstModelOnPlate: (plateId: string) => {
          const instancePlates = new Map((plateSession?.instances ?? []).map((instance) =>
            [`${instance.objectIndex}:${instance.instanceIndex}`, instance.plateId]));
          const volume = glVolumes.find((candidate) =>
            instancePlates.get(`${candidate.buffer.objectIdx}:${candidate.buffer.instanceIdx}`) === plateId);
          sceneInteraction.clearSelection();
          return Boolean(volume && sceneInteraction.selectFromHit(volume, false));
        },
        realProjectMoveSelectedX: (delta: number) => {
          const startedAt = performance.now();
          return {
            moved: Number.isFinite(delta) &&
              sceneInteraction.moveSelectionBy(new THREE.Vector3(delta, 0, 0)),
            startedAt,
          };
        },
        realProjectModelWorldCentersProfile: () => {
          const startedAt = performance.now();
          const centers = previewVolumes.map((volume) => {
            const center = volume.getWorldBounds().getCenter(new THREE.Vector3());
            return [center.x, center.y, center.z] as [number, number, number];
          });
          return {
            identity: 'ORCA_REAL_PROJECT_BOUNDS_PROFILE_V1' as const,
            durationMs: performance.now() - startedAt,
            centers,
          };
        },
        realProjectRendererMemorySnapshot: () => {
          const instancePlates = new Map((plateSession?.instances ?? []).map((instance) =>
            [`${instance.objectIndex}:${instance.instanceIndex}`, instance.plateId]));
          const totals = new Map<string, {
            reactTypedArrayBytes: number;
            gpuProjectionEstimatedBytes: number;
            volumeCount: number;
          }>();
          const countedGeometry = new Set<THREE.BufferGeometry>();
          const plateGeometry = new Map<string, Set<THREE.BufferGeometry>>();
          let reactTypedArrayBytes = 0;
          let gpuProjectionEstimatedBytes = 0;
          for (const volume of glVolumes) {
            const sourceBytes = volume.buffer.positions.byteLength + volume.buffer.indices.byteLength;
            let gpuBytes = volume.geometry.index?.array.byteLength ?? 0;
            for (const attribute of Object.values(volume.geometry.attributes))
              gpuBytes += attribute.array.byteLength;
            if (!countedGeometry.has(volume.geometry)) {
              countedGeometry.add(volume.geometry);
              reactTypedArrayBytes += sourceBytes;
              gpuProjectionEstimatedBytes += gpuBytes;
            }
            const plateId = instancePlates.get(`${volume.buffer.objectIdx}:${volume.buffer.instanceIdx}`) ?? 'unassigned';
            const plate = totals.get(plateId) ?? {
              reactTypedArrayBytes: 0,
              gpuProjectionEstimatedBytes: 0,
              volumeCount: 0,
            };
            const countedPlate = plateGeometry.get(plateId) ?? new Set<THREE.BufferGeometry>();
            if (!countedPlate.has(volume.geometry)) {
              countedPlate.add(volume.geometry);
              plateGeometry.set(plateId, countedPlate);
              plate.reactTypedArrayBytes += sourceBytes;
              plate.gpuProjectionEstimatedBytes += gpuBytes;
            }
            plate.volumeCount += 1;
            totals.set(plateId, plate);
          }
          return {
            identity: 'ORCA_REAL_PROJECT_PROFILE_RENDERER_V1' as const,
            reactTypedArrayBytes,
            gpuProjectionEstimatedBytes,
            volumeCount: glVolumes.length,
            perPlate: [...totals].sort(([lhs], [rhs]) => lhs.localeCompare(rhs))
              .map(([plateId, values]) => ({ plateId, ...values })),
          };
        },
      } : {}),
    };
    return () => {
      if (w.__orcaE2e) {
        if (import.meta.env.VITE_REAL_PROJECT_PROFILE === '1') {
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
            modelMaterialColours: _modelColours,
            previewToolpathWorldBounds: _toolpathBounds,
            realProjectModelWorldCentersProfile: _realProjectBounds,
            realProjectRendererMemorySnapshot: _realProjectMemory,
            realProjectPlateModelWorldCenters: _realProjectPlateModelWorldCenters,
            realProjectSelectFirstModelOnPlate: _realProjectSelectFirstModelOnPlate,
            realProjectMoveSelectedX: _realProjectMoveSelectedX,
            ...rest
          } = w.__orcaE2e;
          w.__orcaE2e = rest;
        } else {
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
            modelMaterialColours: _modelColours,
            previewToolpathWorldBounds: _toolpathBounds,
            ...rest
          } = w.__orcaE2e;
          w.__orcaE2e = rest;
        }
      }
    };
  }, [activeTab, camera, controls, glVolumes, plateSession, previewVolumes, scene, size, sceneInteraction, toolpath]);

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
        : isPreviewTab(activeTab) && currentPreviewPlate(plateSession)
          ? <BedPlate plate={currentPreviewPlate(plateSession)!} current />
          : <BedPlate />}
      {isPreviewTab(activeTab) ? (
        <PreviewScene
          controller={controller}
          wipeTowerVolumes={wipeTowerVolumes}
          glVolumes={previewVolumes}
          toolpath={toolpath}
          structure={structure}
          plateSession={plateSession}
        />
      ) : (
        <PrepareScene glVolumes={glVolumes} toolpath={toolpath} structure={structure} plateSession={plateSession} controller={controller} wipeTowerVolumes={wipeTowerVolumes} />
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
function PrepareScene({ glVolumes, toolpath, structure, plateSession, controller, wipeTowerVolumes }: {
  glVolumes: LoadedObject[];
  toolpath: ToolpathGeometry | null;
  structure: readonly ModelObjectStructure[];
  plateSession?: PlateSessionSnapshot | null;
  controller: SceneInteractionController;
  wipeTowerVolumes?: WipeTowerVolumeCollection;
}) {
  const subscribeSelection = useCallback((listener: () => void) => controller.selection.subscribe(listener), [controller]);
  const subscribeScene = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
  const selectionRevision = useSyncExternalStore(subscribeSelection, () => controller.selection.revision);
  const bodyDragEnabled = useSyncExternalStore(subscribeScene, () => controller.bodyDragEnabled);
  return <SceneContentTree glVolumes={glVolumes} toolpath={null} interactive structure={structure} plateSession={plateSession}
    controller={controller} wipeTowerVolumes={wipeTowerVolumes} selectionRevision={selectionRevision} bodyDragEnabled={bodyDragEnabled} />;
}

function PreviewScene({ glVolumes, toolpath, structure, plateSession, controller, wipeTowerVolumes }: {
  controller: SceneInteractionController;
  wipeTowerVolumes?: WipeTowerVolumeCollection;
  glVolumes: LoadedObject[];
  toolpath: ToolpathGeometry | null;
  structure?: readonly ModelObjectStructure[];
  plateSession?: PlateSessionSnapshot | null;
}) {
  return <SceneContentTree glVolumes={glVolumes} toolpath={toolpath} interactive={false} preview structure={structure} plateSession={plateSession}
    controller={controller} wipeTowerVolumes={wipeTowerVolumes} selectionRevision={0} bodyDragEnabled={false} />;
}

function SceneContentTree({ glVolumes, toolpath, interactive, preview = false, structure = [], plateSession, controller, wipeTowerVolumes, selectionRevision, bodyDragEnabled }: {
  glVolumes: LoadedObject[];
  toolpath: ToolpathGeometry | null;
  interactive: boolean;
  preview?: boolean;
  structure?: readonly ModelObjectStructure[];
  plateSession?: PlateSessionSnapshot | null;
  controller: SceneInteractionController;
  wipeTowerVolumes?: WipeTowerVolumeCollection;
  selectionRevision: number;
  bodyDragEnabled: boolean;
}) {
  return (
    <>
      {interactive && wipeTowerVolumes && <WipeTowerVolumes collection={wipeTowerVolumes}
        selectionRevision={selectionRevision} bodyDragEnabled={bodyDragEnabled} />}
      {glVolumes.map((volume) => (
        <GLVolumeMesh key={volume.id} data={volume} interactive={interactive} preview={preview} structure={structure} plateSession={plateSession}
          selectionRevision={selectionRevision} bodyDragEnabled={bodyDragEnabled} />
      ))}
      {interactive && <SelectionBoundsBox />}
      {interactive && <SelectionTransformGizmo />}
      {/* The slicing bridge publishes world-space preview moves. The separate
          source G-code remains printer-local for export/send, so this render
          group deliberately has no plate translation. */}
      {toolpath && preview && <group name="preview-toolpath-world"><ToolpathLines data={toolpath} /><ToolpathMarker data={toolpath} /></group>}
      {toolpath && !preview && <ToolpathLines data={toolpath} />}
      {toolpath && !preview && <ToolpathMarker data={toolpath} />}
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

  // The attached TransformControls target is normally an implementation
  // detail. E2E exposes just its world pivot so a real pointer gesture can
  // prove it follows the same Worker-confirmed tower position as the mesh and
  // selection bounds.
  useEffect(() => {
    const env = import.meta.env as { MODE?: string; VITE_E2E?: string };
    if (env.MODE !== 'e2e' && env.VITE_E2E !== '1') return;
    const w = window as unknown as {
      __orcaE2e?: { gizmoTargetWorld?: () => [number, number, number] | null };
    };
    w.__orcaE2e = {
      ...w.__orcaE2e,
      gizmoTargetWorld: () => {
        const group = pivotRef.current;
        if (!group) return null;
        group.updateWorldMatrix(true, false);
        const position = new THREE.Vector3();
        group.getWorldPosition(position);
        return [position.x, position.y, position.z];
      },
    };
    return () => {
      if (!w.__orcaE2e) return;
      const { gizmoTargetWorld: _target, ...rest } = w.__orcaE2e;
      w.__orcaE2e = rest;
    };
  }, []);

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
