// One renderer GLVolume. Prepare models forward pointer events to the scene
// controller; Preview models are passive render-only shells.
import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { DragControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useSceneInteraction } from './SceneInteractionContext';
import type { GLVolume } from './GLVolume';
import { MODEL_BODY_RAYCAST } from './buildPlatePointerOcclusion';
import { EULER_ORDER } from './transformDeltaMath';
import { acceleratedRaycast } from 'three-mesh-bvh';
import type { ModelObjectStructure, PlateSessionSnapshot } from '@slicer/client';
import { useFilamentSessionStore } from '../../../stores/useFilamentSessionStore';
import {
  canRenderPreparePaint,
  isModelInstanceMarkedUnprintable,
  prepareColourForVolume,
  preparePaintMaterialOverlays,
  resolvePrepareMaterial,
  resolveUnprintableMaterial,
} from './prepareColourProjection';
import { WipeTowerVolume } from './WipeTowerVolume';

const BAND_Z_FUDGE = 0.0005;
export const BVH_RAYCAST = acceleratedRaycast;
export const NO_RAYCAST: THREE.Object3D['raycast'] = () => undefined;

function applyTransform(group: THREE.Group, transform: GLVolume['instanceTransform']) {
  if (transform.matrix) {
    group.matrixAutoUpdate = false;
    group.matrix.fromArray(transform.matrix);
    group.matrixWorldNeedsUpdate = true;
    return;
  }
  const { offset, rotation, scale, mirror } = transform;
  group.matrixAutoUpdate = true;
  group.position.set(...offset);
  group.rotation.order = EULER_ORDER;
  group.rotation.set(...rotation);
  group.scale.set(scale[0] * mirror[0], scale[1] * mirror[1], scale[2] * mirror[2]);
  group.updateMatrix();
}

export const GLVolumeMesh = memo(function GLVolumeMesh({ data, interactive = true, preview = false, structure = [], plateSession, selectionRevision, bodyDragEnabled, onModelSelection }: {
  data: GLVolume;
  interactive?: boolean;
  preview?: boolean;
  structure?: readonly ModelObjectStructure[];
  plateSession?: PlateSessionSnapshot | null;
  selectionRevision: number;
  bodyDragEnabled: boolean;
  onModelSelection?: () => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const volumeGroupRef = useRef<THREE.Group>(null);
  const bodyStartRef = useRef(new THREE.Vector3());
  const selectedOnPointerDownRef = useRef(false);
  const invalidate = useThree((s) => s.invalidate);
  const sceneInteraction = useSceneInteraction();
  const filamentSnapshot = useFilamentSessionStore((state) => state.snapshot);
  const selected = !preview && sceneInteraction.selection.has(data);
  const markedUnprintable = !preview && !(data instanceof WipeTowerVolume)
    && isModelInstanceMarkedUnprintable(data, structure);
  const paintedPrintable = !(data instanceof WipeTowerVolume) && data.paintGeometry !== null
    && canRenderPreparePaint(data, structure);
  const prepareColour = !preview
    ? prepareColourForVolume(data, structure, filamentSnapshot, plateSession)
    : '#cbd5e1';
  const material = markedUnprintable
    ? resolveUnprintableMaterial(selected)
    : resolvePrepareMaterial({ baseColour: prepareColour, selected, transparent: preview });
  const paintMaterials = paintedPrintable
    ? preparePaintMaterialOverlays(data, data.paintDrawGroups, structure, filamentSnapshot, plateSession, selected, preview)
    : [];
  const scratch = useMemo(() => new THREE.Vector3(), []);

  const applySceneTransforms = useCallback(() => {
    const group = groupRef.current;
    const volume = volumeGroupRef.current;
    if (!group || !volume) return;
    group.matrixAutoUpdate = true;
    volume.matrixAutoUpdate = true;
    applyTransform(group, data.instanceTransform);
    applyTransform(volume, data.volumeTransform);
    invalidate();
  }, [data, invalidate]);

  useLayoutEffect(() => {
    applySceneTransforms();
    return sceneInteraction.subscribe(applySceneTransforms);
  }, [applySceneTransforms, data.instanceTransform, data.volumeTransform, sceneInteraction]);

  // Snapshot the first committed Preview materials for integration tests. This
  // runs after React Three Fiber has attached the materials to the paint mesh,
  // so the assertion observes the same commit the renderer can first draw.
  useLayoutEffect(() => {
    const env = import.meta.env as { MODE?: string; VITE_E2E?: string };
    if (!preview || (env.MODE !== 'e2e' && env.VITE_E2E !== '1') || !paintMaterials.length) return;
    const volumeGroup = volumeGroupRef.current;
    if (!volumeGroup) return;
    const paintMesh = volumeGroup.getObjectByName('orca-painted-model-display') as THREE.Mesh | undefined;
    if (!paintMesh) return;
    const materials = Array.isArray(paintMesh.material) ? paintMesh.material : [paintMesh.material];
    const snapshot = materials.flatMap((material, materialIndex) => {
      if (!(material instanceof THREE.MeshStandardMaterial)) return [];
      return [{
        id: data.id,
        objectIndex: data.buffer.objectIdx,
        volumeIndex: data.buffer.volumeIdx,
        instanceIndex: data.buffer.instanceIdx,
        stateId: data.paintDrawGroups[materialIndex]?.stateId ?? 0,
        colour: `#${material.color.getHexString()}`,
        opacity: material.opacity,
        transparent: material.transparent,
        depthWrite: material.depthWrite,
      }];
    });
    if (snapshot.length !== paintMaterials.length) return;
    const w = window as unknown as {
      __orcaE2e?: {
        previewFirstCommitPaintMaterialsByVolume?: Record<string, typeof snapshot>;
      };
    };
    const current = w.__orcaE2e?.previewFirstCommitPaintMaterialsByVolume ?? {};
    if (current[data.id]) return;
    w.__orcaE2e = {
      ...w.__orcaE2e,
      previewFirstCommitPaintMaterialsByVolume: {
        ...current,
        [data.id]: snapshot,
      },
    };
  }, [data, paintMaterials, preview]);

  const modelMesh = (
    <group ref={volumeGroupRef}>
      <group
        userData={{ orcaRaycastRole: data instanceof WipeTowerVolume ? 'prime-tower' : MODEL_BODY_RAYCAST, orcaVolume: data,
          ...(data instanceof WipeTowerVolume ? { plateId: data.plateId, primeTower: true } : {}) }}
        onPointerDown={interactive ? (event) => {
          if (event.nativeEvent.button !== 0) return;
          onModelSelection?.();
          if (!sceneInteraction.pointerStartsOnGizmo) {
            event.nativeEvent.stopImmediatePropagation();
          }
          selectedOnPointerDownRef.current = sceneInteraction.prepareBodyDragFromPointerDown(
            data,
            event.nativeEvent.ctrlKey || event.nativeEvent.metaKey,
            event.nativeEvent.altKey,
          );
        } : undefined}
        onClick={interactive ? (event) => {
          event.stopPropagation();
          if (selectedOnPointerDownRef.current) {
            selectedOnPointerDownRef.current = false;
            return;
          }
          if (sceneInteraction.owner !== 'none') return;
          sceneInteraction.selectFromClick(
            data,
            event.nativeEvent.ctrlKey || event.nativeEvent.metaKey,
            event.nativeEvent.altKey,
          );
        } : undefined}
      >
        {data instanceof WipeTowerVolume ? data.projection.bands.map((band, index) => (
          <mesh key={`${band.slot}-${band.startDepth}`} geometry={data.getBandGeometry(index)} raycast={BVH_RAYCAST}
            position={[data.projection.width / 2, (band.startDepth + band.endDepth) / 2, data.projection.height / 2]}>
            <meshStandardMaterial color={band.colour} transparent opacity={band.opacity} depthWrite roughness={0.7}
              polygonOffset polygonOffsetFactor={BAND_Z_FUDGE} />
          </mesh>
        )) : paintedPrintable && data.paintGeometry ? <>
          <mesh name="orca-painted-model-display" geometry={data.paintGeometry} raycast={NO_RAYCAST}
            userData={{ orcaModelSurface: 'paint-display' }}>
            {paintMaterials.map((paintMaterial, index) => (
              <meshStandardMaterial
                key={`${paintMaterial.stateId}-${index}`}
                attach={`material-${index}`}
                color={paintMaterial.colour}
                roughness={0.6}
                metalness={0.1}
                side={THREE.DoubleSide}
                transparent={paintMaterial.transparent}
                opacity={paintMaterial.opacity}
                depthWrite={paintMaterial.depthWrite}
              />
            ))}
          </mesh>
          {!preview && <mesh name="orca-original-model-pick" geometry={data.geometry} raycast={BVH_RAYCAST} visible={false}
            userData={{ orcaModelSurface: 'original-pick' }} />}
        </> : <mesh geometry={data.geometry} raycast={BVH_RAYCAST}>
          <meshStandardMaterial
          color={material.colour}
          roughness={0.6}
          metalness={0.1}
          side={THREE.DoubleSide}
          transparent={material.transparent}
          opacity={material.opacity}
          depthWrite={material.depthWrite}
          />
        </mesh>}
      </group>
    </group>
  );

  if (!interactive) {
    // No DragControls or pointer handlers are mounted in Preview.
    return <group ref={groupRef}>{modelMesh}</group>;
  }

  return (
    <DragControls
      ref={groupRef}
      autoTransform={false}
      axisLock="z"
      // Every selectable scene entity is armed before its pointer-down handler
      // can synchronously select it. Gating this through React selection state
      // loses a same-frame first move; the controller owns arbitration and
      // admits only its recorded pointer-down candidate. In particular, Prime
      // Tower uses this exact DragControls path rather than a conditional
      // enablement workaround.
      dragConfig={{ enabled: bodyDragEnabled }}
      onDragStart={(origin) => {
        if (!sceneInteraction.tryBeginBodyDrag(data)) return;
        bodyStartRef.current.copy(origin);
      }}
      onDrag={(localMatrix) => {
        if (sceneInteraction.owner !== 'body') return;
        const start = sceneInteraction.activeDrag?.startPivot;
        if (!start) return;
        scratch.setFromMatrixPosition(localMatrix).sub(bodyStartRef.current);
        sceneInteraction.updateDragPivot(start.clone().add(scratch));
        invalidate();
      }}
      onDragEnd={() => {
        if (sceneInteraction.owner === 'body') sceneInteraction.endDrag();
      }}
    >
      {modelMesh}
    </DragControls>
  );
}, (previous, next) => previous.data === next.data
  && previous.interactive === next.interactive
  && previous.preview === next.preview
  && previous.structure === next.structure
  && previous.selectionRevision === next.selectionRevision
  && previous.bodyDragEnabled === next.bodyDragEnabled
  // Selection navigation replaces only the outer session object. Membership
  // and validity arrays remain identical, so avoid remounting every model
  // mesh for a currentPlateId-only change.
  && previous.plateSession?.instances === next.plateSession?.instances
  && previous.onModelSelection === next.onModelSelection);
