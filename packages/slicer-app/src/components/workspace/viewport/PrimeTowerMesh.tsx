import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { TransformControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import type { PlateSessionSnapshot, PrimeTowerPlateProjection } from '@slicer/client';
import { useSceneInteraction } from './SceneInteractionContext';
import { PrimeTowerInteractionController, usePrimeTowerInteractionVersion } from './PrimeTowerInteractionController';
import { primeTowerWorldBounds } from './primeTowerGeometry';
import { selectionBoundsBoxPositions } from './selectionBoundsBoxGeometry';

const BAND_Z_FUDGE = 0.0005;
const SEGMENT_VERTEX_COUNT = 48;

export function PrimeTowerProxies({
  controller,
  plateSession,
}: {
  controller: PrimeTowerInteractionController;
  plateSession?: PlateSessionSnapshot | null;
}) {
  usePrimeTowerInteractionVersion(controller);
  const projection = controller.projection;
  const scene = useThree((state) => state.scene);
  useEffect(() => {
    const env = import.meta.env as { MODE?: string; VITE_E2E?: string; VITE_USE_MOCK?: string };
    if (env.MODE !== 'e2e' && env.VITE_E2E !== '1' && env.VITE_USE_MOCK !== '1') return;
    const w = window as unknown as { __orcaE2e?: {
      primeTowerStates?: () => Array<{
        plateId: string;
        current: boolean;
        eligible: boolean;
        empty: boolean;
        selected: boolean;
        position: { x: number; y: number };
        bands: number;
        colours: string[];
        opacity: number[];
        footprint: { minX: number; maxX: number; minY: number; maxY: number };
        buildArea: { minX: number; maxX: number; minY: number; maxY: number };
        outsideBoundaryWarning: boolean;
      }>;
      primeTowerSelection?: () => string | null;
      primeTowerMoveCommands?: () => number;
      primeTowerProxyIds?: () => string[];
    } };
    w.__orcaE2e = {
      ...w.__orcaE2e,
      primeTowerStates: () => controller.projection?.plates.map((plate) => ({
        plateId: plate.plateId,
        current: plate.plateId === controller.projection?.currentPlateId,
        eligible: plate.eligible,
        empty: plate.empty,
        selected: plate.plateId === controller.selectedPlateId,
        position: controller.transientPosition && plate.plateId === controller.selectedPlateId
          ? controller.transientPosition : plate.position,
        bands: plate.bands.length,
        colours: plate.bands.map((band) => band.colour),
        opacity: plate.bands.map((band) => band.opacity),
        footprint: { ...plate.footprint },
        buildArea: { minX: plate.buildArea.minX, maxX: plate.buildArea.maxX, minY: plate.buildArea.minY, maxY: plate.buildArea.maxY },
        outsideBoundaryWarning: plate.outsideBoundaryWarning === true,
      })) ?? [],
      primeTowerSelection: () => controller.selectedPlateId,
      primeTowerMoveCommands: () => controller.moveCommandCount,
      // Enumerate the mounted Three.js groups, rather than the projection,
      // so the hook proves which proxies are actually present in the scene.
      primeTowerProxyIds: () => {
        const ids = new Set<string>();
        scene.traverse((object) => {
          if (object.userData.primeTower !== true || typeof object.userData.plateId !== 'string') return;
          ids.add(object.userData.plateId);
        });
        return [...ids].sort();
      },
    };
    return () => {
      if (!w.__orcaE2e) return;
      const { primeTowerStates: _states, primeTowerSelection: _selection, primeTowerMoveCommands: _commands, primeTowerProxyIds: _proxyIds, ...rest } = w.__orcaE2e;
      w.__orcaE2e = rest;
    };
  }, [controller, scene]);
  if (!projection || !plateSession) return null;
  return (
    <>
      {projection.plates.filter((plate) => plate.eligible).map((plate) => {
        const sessionPlate = plateSession.plates.find((candidate) => candidate.plateId === plate.plateId);
        if (!sessionPlate) return null;
        return (
          <PrimeTowerMesh
            key={plate.plateId}
            projection={plate}
            plateOrigin={sessionPlate.origin}
            interactive={plate.plateId === projection.currentPlateId}
            controller={controller}
          />
        );
      })}
    </>
  );
}

function PrimeTowerMesh({
  projection,
  plateOrigin,
  interactive,
  controller,
}: {
  projection: PrimeTowerPlateProjection;
  plateOrigin: readonly [number, number, number];
  interactive: boolean;
  controller: PrimeTowerInteractionController;
}) {
  usePrimeTowerInteractionVersion(controller);
  const groupRef = useRef<THREE.Group>(null);
  const [target, setTarget] = useState<THREE.Group | null>(null);
  const attachTarget = useCallback((group: THREE.Group | null) => {
    groupRef.current = group;
    setTarget((current) => current === group ? current : group);
  }, []);
  const sceneInteraction = useSceneInteraction();
  const camera = useThree((state) => state.camera);
  const domElement = useThree((state) => state.gl.domElement);
  const raycaster = useThree((state) => state.raycaster);
  const invalidate = useThree((state) => state.invalidate);
  const selected = controller.selectedPlateId === projection.plateId;
  const gizmoArmed = selected && controller.gizmoArmed;
  const position = selected && controller.transientPosition ? controller.transientPosition : projection.position;

  const syncGroup = useCallback(() => {
    const group = groupRef.current;
    if (!group) return;
    group.position.set(plateOrigin[0] + position.x, plateOrigin[1] + position.y, plateOrigin[2]);
    group.rotation.set(0, 0, projection.rotation * Math.PI / 180);
    group.updateMatrixWorld();
    invalidate();
  }, [invalidate, plateOrigin, position, projection.rotation]);
  useLayoutEffect(syncGroup, [syncGroup]);

  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 0, 1), -plateOrigin[2]), [plateOrigin]);
  const worldAt = useCallback((event: PointerEvent): THREE.Vector3 | null => {
    const bounds = domElement.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    raycaster.setFromCamera(new THREE.Vector2(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    ), camera);
    const result = new THREE.Vector3();
    return raycaster.ray.intersectPlane(plane, result) ?? null;
  }, [camera, domElement, plane, raycaster]);

  const pointerIdRef = useRef<number | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  const stopGesture = useCallback((cancel: boolean) => {
    detachRef.current?.();
    detachRef.current = null;
    pointerIdRef.current = null;
    if (cancel) controller.cancelGesture();
    else controller.endGesture();
    sceneInteraction.releaseExternalPointer();
    invalidate();
  }, [controller, invalidate, sceneInteraction]);
  const onPointerMove = useCallback((event: PointerEvent) => {
    if (event.pointerId !== pointerIdRef.current) return;
    const point = worldAt(event);
    if (!point) return;
    controller.updateBody(point);
    event.preventDefault();
    invalidate();
  }, [controller, invalidate, worldAt]);
  const onPointerUp = useCallback((event: PointerEvent) => {
    if (event.pointerId !== pointerIdRef.current) return;
    stopGesture(false);
  }, [stopGesture]);
  const onPointerCancel = useCallback((event: PointerEvent) => {
    if (event.pointerId !== pointerIdRef.current) return;
    stopGesture(true);
  }, [stopGesture]);
  const onBlur = useCallback(() => {
    if (pointerIdRef.current !== null) stopGesture(true);
  }, [stopGesture]);
  const attachGesture = useCallback(() => {
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerCancel, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerCancel, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [onBlur, onPointerCancel, onPointerMove, onPointerUp]);
  useEffect(() => () => {
    detachRef.current?.();
    if (pointerIdRef.current !== null) {
      controller.cancelGesture();
      sceneInteraction.releaseExternalPointer();
    }
  }, [controller, sceneInteraction]);

  const handlePointerDown = useCallback((event: { nativeEvent: PointerEvent; stopPropagation: () => void }) => {
    if (!interactive || event.nativeEvent.button !== 0) return;
    event.stopPropagation();
    event.nativeEvent.preventDefault();
    event.nativeEvent.stopImmediatePropagation();
    sceneInteraction.clearSelection();
    const point = worldAt(event.nativeEvent);
    if (!point || !controller.beginBody(projection.plateId, point)) return;
    if (!sceneInteraction.claimExternalPointer()) {
      controller.cancelGesture();
      return;
    }
    pointerIdRef.current = event.nativeEvent.pointerId;
    detachRef.current = attachGesture();
  }, [attachGesture, controller, interactive, projection.plateId, sceneInteraction, worldAt]);

  const bounds = selected ? primeTowerWorldBounds(projection, position, plateOrigin) : null;
  return (
    <>
      <group
        ref={attachTarget}
        userData={{ orcaRaycastRole: 'prime-tower', plateId: projection.plateId, plateCurrent: interactive, primeTower: true }}
        onPointerDown={interactive ? handlePointerDown : undefined}
      >
        {projection.bands.map((band) => (
          <mesh key={`${band.slot}-${band.startDepth}`} raycast={!interactive ? () => undefined : undefined} position={[projection.width / 2, (band.startDepth + band.endDepth) / 2, projection.height / 2]}>
            <boxGeometry args={[projection.width, band.endDepth - band.startDepth, Math.max(projection.height, 0.1)]} />
            <meshStandardMaterial
              color={band.colour}
              transparent
              opacity={band.opacity}
              depthWrite
              roughness={0.7}
              polygonOffset
              polygonOffsetFactor={BAND_Z_FUDGE}
            />
          </mesh>
        ))}
      </group>
      {selected && !gizmoArmed && bounds && <PrimeTowerSelectionBounds bounds={bounds} />}
      {gizmoArmed && interactive && <PrimeTowerGizmo
        target={target}
        projection={projection}
        plateOrigin={plateOrigin}
        controller={controller}
        invalidate={invalidate}
      />}
    </>
  );
}

function PrimeTowerSelectionBounds({ bounds }: { bounds: THREE.Box3 }) {
  const geometry = useMemo(() => {
    const value = new THREE.BufferGeometry();
    value.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(SEGMENT_VERTEX_COUNT * 3), 3));
    return value;
  }, []);
  useLayoutEffect(() => {
    const attribute = geometry.getAttribute('position') as THREE.BufferAttribute;
    (attribute.array as Float32Array).set(selectionBoundsBoxPositions(bounds));
    attribute.needsUpdate = true;
    geometry.computeBoundingSphere();
  }, [bounds, geometry]);
  return <lineSegments geometry={geometry} frustumCulled={false} raycast={() => undefined}><lineBasicMaterial color={0xffffff} /></lineSegments>;
}

function PrimeTowerGizmo({
  target,
  projection,
  plateOrigin,
  controller,
  invalidate,
}: {
  target: THREE.Group | null;
  projection: PrimeTowerPlateProjection;
  plateOrigin: readonly [number, number, number];
  controller: PrimeTowerInteractionController;
  invalidate: () => void;
}) {
  const sceneInteraction = useSceneInteraction();
  const controlsRef = useRef<React.ComponentRef<typeof TransformControls> | null>(null);
  const claimedRef = useRef(false);
  const resetControls = useCallback((value: React.ComponentRef<typeof TransformControls> | null = controlsRef.current) => {
    const controls = value as unknown as {
      dragging?: boolean;
      axis?: string | null;
      dispatchEvent?: (event: { type: string; value: boolean }) => void;
    } | null;
    if (!controls) return;
    const shouldRestoreCamera = controls.dragging === true || claimedRef.current;
    // three-stdlib.detach() clears the attached object and axis, but it does
    // not terminate an active drag or emit dragging-changed(false). Drei uses
    // that event to re-enable OrbitControls, so force the same terminal state
    // on every interruption before the control unmounts.
    controls.dragging = false;
    controls.axis = null;
    if (shouldRestoreCamera) controls.dispatchEvent?.({ type: 'dragging-changed', value: false });
  }, []);
  const cancelGizmo = useCallback(() => {
    if (!claimedRef.current) return;
    if (controller.owner === 'gizmo') controller.cancelGesture();
    resetControls();
    sceneInteraction.releaseExternalPointer();
    claimedRef.current = false;
    invalidate();
  }, [controller, invalidate, resetControls, sceneInteraction]);
  useEffect(() => {
    window.addEventListener('pointercancel', cancelGizmo, true);
    window.addEventListener('blur', cancelGizmo);
    return () => {
      window.removeEventListener('pointercancel', cancelGizmo, true);
      window.removeEventListener('blur', cancelGizmo);
      cancelGizmo();
    };
  }, [cancelGizmo]);
  useEffect(() => {
    const controls = controlsRef.current;
    return () => resetControls(controls);
  }, [resetControls]);
  useEffect(() => {
    const env = import.meta.env as { MODE?: string; VITE_E2E?: string; VITE_USE_MOCK?: string };
    if (env.MODE !== 'e2e' && env.VITE_E2E !== '1' && env.VITE_USE_MOCK !== '1') return;
    const w = window as unknown as { __orcaE2e?: { primeTowerGizmoAxis?: () => string | null } };
    w.__orcaE2e = {
      ...w.__orcaE2e,
      primeTowerGizmoAxis: () => (controlsRef.current as unknown as { axis?: string | null } | null)?.axis ?? null,
    };
    return () => {
      if (!w.__orcaE2e) return;
      const { primeTowerGizmoAxis: _axis, ...rest } = w.__orcaE2e;
      w.__orcaE2e = rest;
    };
  }, []);
  if (!target) return null;
  return (
    <TransformControls
      ref={controlsRef}
      object={target}
      mode="translate"
      space="world"
      showX
      showY
      showZ={false}
      enabled={controller.owner !== 'body'}
      onMouseDown={() => {
        // TransformControls has already set dragging=true and disabled the
        // default camera before Drei invokes this callback. Rejecting a
        // press (for example while a native move is settling) must therefore
        // terminate that third-party gesture immediately, even though this
        // component never claimed external scene ownership.
        const began = controller.beginGizmo(projection.plateId);
        if (!began) {
          controller.cancelGesture();
          resetControls();
          return;
        }
        if (!sceneInteraction.claimExternalPointer()) {
          controller.cancelGesture();
          resetControls();
          return;
        }
        claimedRef.current = true;
      }}
      onObjectChange={() => {
        if (controller.owner !== 'gizmo') return;
        target.position.z = plateOrigin[2];
        controller.updateGizmo({ x: target.position.x - plateOrigin[0], y: target.position.y - plateOrigin[1] });
        invalidate();
      }}
      onMouseUp={() => {
        if (controller.owner === 'gizmo') controller.endGesture();
        if (claimedRef.current) {
          sceneInteraction.releaseExternalPointer();
          claimedRef.current = false;
        }
      }}
    />
  );
}
