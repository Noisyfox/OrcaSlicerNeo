import { useEffect, type RefObject } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import type { PlateSessionSnapshot } from '@slicer/client';
import { glVolumeCollection } from '../components/workspace/viewport/GLVolume';
import { getPrintableAreaBounds, normalizePrintableArea } from '../components/workspace/viewport/BedPlate';
import { BVH_RAYCAST, NO_RAYCAST } from '../components/workspace/viewport/ModelMesh';
import { BUILD_PLATE_RAYCAST, MODEL_BODY_RAYCAST } from '../components/workspace/viewport/buildPlatePointerOcclusion';
import type { SceneInteractionController } from '../components/workspace/viewport/SceneInteractionController';
import type { LoadedObject } from '../components/workspace/viewport/useModelLoader';
import type { ToolpathGeometry } from '../components/workspace/viewport/useSliceResult';
import { useFilamentSessionStore } from '../stores/useFilamentSessionStore';
import { useProjectStore } from '../stores/useProjectStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { registerOrcaE2eOwnerAfterPassiveEffects } from './registerOrcaE2e';

interface SceneE2eProbeProps {
  activeTab: 'prepare' | 'preview';
  sceneInteraction: SceneInteractionController;
  glVolumes: LoadedObject[];
  previewVolumes: LoadedObject[];
  plateSession?: PlateSessionSnapshot | null;
  toolpath: ToolpathGeometry | null;
}

export function SceneE2eProbe({ activeTab, sceneInteraction, glVolumes, previewVolumes, plateSession, toolpath }: SceneE2eProbeProps) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls as unknown as { target?: THREE.Vector3; enabled?: boolean; update?: () => void } | undefined);
  const invalidate = useThree((s) => s.invalidate);
  const scene = useThree((s) => s.scene);
  const size = useThree((s) => s.size);
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
        quaternion: [number, number, number, number];
        target: [number, number, number];
        near: number;
        far: number;
        controlsEnabled?: boolean;
      };
      setCameraView?: (position: [number, number, number], target: [number, number, number]) => void;
      bedPlateStates?: () => Array<{
        plateId?: string;
        current: boolean;
        outOfBounds: boolean;
        position: [number, number, number];
        bounds: { minX: number; maxX: number; minY: number; maxY: number };
      }>;
      modelWorldCenters?: () => Array<[number, number, number]>;
      modelMaterialColours?: () => Array<{
        id: string;
        objectIndex: number;
        volumeIndex: number;
        stateId: number;
        colour: string;
        opacity: number;
        transparent: boolean;
        depthWrite: boolean;
      }>;
      previewFirstCommitPaintMaterialsByVolume?: Record<string, Array<{
        id: string;
        objectIndex: number;
        volumeIndex: number;
        instanceIndex: number;
        stateId: number;
        colour: string;
        opacity: number;
        transparent: boolean;
        depthWrite: boolean;
      }>>;
      previewFirstCommitPaintMaterials?: () => Array<{
        id: string;
        objectIndex: number;
        volumeIndex: number;
        instanceIndex: number;
        stateId: number;
        colour: string;
        opacity: number;
        transparent: boolean;
        depthWrite: boolean;
      }>;
      modelFilamentState?: () => {
        pendingKind: string | null;
        rejected: string | null;
        slots: Array<{ slot: number; colour: string }>;
        partAssignments: Array<{ id: number; effectiveSlot: number }>;
      };
      modelPaintResources?: () => Array<{
        id: string;
        objectIndex: number;
        volumeIndex: number;
        instanceIndex: number;
        originalGeometryUuid: string;
        originalHasBvh: boolean;
        paintGeometryUuid: string | null;
        paintHasBvh: boolean;
        paintGroupStates: number[];
        visibleGeometryUuid: string | null;
        visibleUsesOriginalGeometry: boolean;
        visibleUsesBvhRaycast: boolean;
        paintDisplayRaycastDisabled: boolean;
        originalPickVisible: boolean | null;
        originalPickUsesBvhRaycast: boolean;
      }>;
      modelSelectionIdentities?: () => Array<{ id: string; objectId: number; volumeId: number; instanceId: number }>;
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
  useEffect(() => registerOrcaE2eOwnerAfterPassiveEffects('scene-rendering', {
    projectWorldToScreen(p: [number, number, number]) {
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
    selectMockInstance(instanceIdx: number, additive = true) {
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
    setCameraView: (position: [number, number, number], target: [number, number, number]) => {
      camera.position.fromArray(position);
      controls?.target?.fromArray(target);
      camera.lookAt(new THREE.Vector3(...target));
      controls?.update?.();
      invalidate();
    },
    cameraState: () => ({
      position: [camera.position.x, camera.position.y, camera.position.z],
      quaternion: [camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w],
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
    bedModelStates: () => {
      const models: Array<{ geometry: string; vertices: number; position: number[]; visible: boolean }> = [];
      scene.traverse((object) => {
        if (object.name !== 'printer-bed-model' || !(object instanceof THREE.Mesh)) return;
        const position = new THREE.Vector3();
        object.getWorldPosition(position);
        models.push({ geometry: object.geometry.uuid, vertices: object.geometry.getAttribute('position').count,
          position: position.toArray(), visible: object.visible && object.parent?.visible !== false });
      });
      return models;
    },
    bedGridStates: () => {
      const grids: Array<{ position: number[]; visible: boolean }> = [];
      scene.traverse((object) => {
        if (object.name !== 'printer-bed-grid') return;
        const position = new THREE.Vector3();
        object.getWorldPosition(position);
        grids.push({ position: position.toArray(), visible: object.visible });
      });
      return grids;
    },
    bedTextureStates: () => {
      const textures: Array<{ path: string; position: number[]; size: number[]; depthWrite: boolean; visible: boolean }> = [];
      scene.traverse((object) => {
        if (object.name !== 'printer-bed-texture' || !(object instanceof THREE.Mesh)) return;
        const material = object.material as THREE.MeshBasicMaterial;
        const map = material.map;
        if (!map) return;
        const position = new THREE.Vector3();
        object.getWorldPosition(position);
        textures.push({ path: map.name, position: position.toArray(),
          size: [(map.image as HTMLCanvasElement).width, (map.image as HTMLCanvasElement).height], depthWrite: material.depthWrite,
          visible: object.visible && object.parent?.visible !== false });
      });
      return textures;
    },
    modelWorldCenters: () => previewVolumes.map((volume) => {
      const center = volume.getWorldBounds().getCenter(new THREE.Vector3());
      return [center.x, center.y, center.z];
    }),
    modelMaterialColours: () => {
      const colours: Array<{
        id: string;
        objectIndex: number;
        volumeIndex: number;
        stateId: number;
        colour: string;
        opacity: number;
        transparent: boolean;
        depthWrite: boolean;
      }> = [];
      scene.traverse((object) => {
        if (object.userData.orcaRaycastRole !== MODEL_BODY_RAYCAST) return;
        const volume = object.userData.orcaVolume as LoadedObject | undefined;
        const mesh = object.getObjectByProperty('type', 'Mesh') as THREE.Mesh | undefined;
        const materials = Array.isArray(mesh?.material) ? mesh.material : [mesh?.material];
        if (!volume) return;
        materials.forEach((material, materialIndex) => {
          if (!(material instanceof THREE.MeshStandardMaterial)) return;
          colours.push({
            id: volume.id,
            objectIndex: volume.buffer.objectIdx,
            volumeIndex: volume.buffer.volumeIdx,
            stateId: volume.paintDrawGroups[materialIndex]?.stateId ?? 0,
            colour: `#${material.color.getHexString()}`,
            opacity: material.opacity,
            transparent: material.transparent,
            depthWrite: material.depthWrite,
          });
        });
      });
      return colours;
    },
    previewFirstCommitPaintMaterials: () => Object.values(
      w.__orcaE2e?.previewFirstCommitPaintMaterialsByVolume ?? {},
    ).flat(),
    modelPaintResources: () => glVolumes.map((volume) => {
      const surfaces: { display: THREE.Object3D | null; originalPick: THREE.Object3D | null; visibleMesh: THREE.Mesh | null } = {
        display: null,
        originalPick: null,
        visibleMesh: null,
      };
      scene.traverse((object) => {
        if (object.userData.orcaVolume !== volume) return;
        surfaces.visibleMesh = object.getObjectByProperty('type', 'Mesh') as THREE.Mesh | null;
        object.traverse((child) => {
          if (child.userData.orcaModelSurface === 'paint-display') surfaces.display = child;
          if (child.userData.orcaModelSurface === 'original-pick') surfaces.originalPick = child;
        });
      });
      return {
        id: volume.id,
        objectIndex: volume.buffer.objectIdx,
        volumeIndex: volume.buffer.volumeIdx,
        instanceIndex: volume.buffer.instanceIdx,
        originalGeometryUuid: volume.geometry.uuid,
        originalHasBvh: 'boundsTree' in volume.geometry && Boolean((volume.geometry as { boundsTree?: unknown }).boundsTree),
        paintGeometryUuid: volume.paintGeometry?.uuid ?? null,
        paintHasBvh: Boolean(volume.paintGeometry && 'boundsTree' in volume.paintGeometry),
        paintGroupStates: volume.paintDrawGroups.map((group) => group.stateId),
        visibleGeometryUuid: surfaces.visibleMesh?.geometry.uuid ?? null,
        visibleUsesOriginalGeometry: surfaces.visibleMesh?.geometry === volume.geometry,
        visibleUsesBvhRaycast: surfaces.visibleMesh?.raycast === BVH_RAYCAST,
        paintDisplayRaycastDisabled: surfaces.display?.raycast === NO_RAYCAST,
        originalPickVisible: surfaces.originalPick?.visible ?? null,
        originalPickUsesBvhRaycast: surfaces.originalPick?.raycast === BVH_RAYCAST,
      };
    }),
    modelFilamentState: () => {
      const state = useFilamentSessionStore.getState();
      const snapshot = state.snapshot;
      return {
        pendingKind: state.pendingKind,
        rejected: state.rejected,
        slots: snapshot?.slots.map((slot) => ({ slot: slot.slot, colour: slot.colour.effective })) ?? [],
        partAssignments: snapshot?.assignments.parts.map((assignment) => ({
          id: assignment.id,
          effectiveSlot: assignment.effectiveSlot,
        })) ?? [],
      };
    },
    modelSelectionIdentities: () => glVolumes.filter((volume) => sceneInteraction.selection.has(volume)).map((volume) => ({
      id: volume.id,
      objectId: volume.buffer.objectId,
      volumeId: volume.buffer.volumeId,
      instanceId: volume.buffer.instanceId,
    })),
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
  }), [activeTab, camera, controls, glVolumes, plateSession, previewVolumes, scene, size, sceneInteraction, toolpath]);
  return null;
}

export function GizmoPivotProbe({ pivotRef }: { pivotRef: RefObject<THREE.Group | null> }) {
  useEffect(() => registerOrcaE2eOwnerAfterPassiveEffects('scene-gizmo-pivot', {
    gizmoTargetWorld: (): [number, number, number] | null => {
      const group = pivotRef.current;
      if (!group) return null;
      group.updateWorldMatrix(true, false);
      const position = new THREE.Vector3();
      group.getWorldPosition(position);
      return [position.x, position.y, position.z];
    },
  }), [pivotRef]);
  return null;
}
