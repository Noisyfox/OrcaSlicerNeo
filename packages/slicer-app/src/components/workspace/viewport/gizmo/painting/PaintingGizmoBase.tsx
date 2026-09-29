import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { acceleratedRaycast } from 'three-mesh-bvh';
import type { PaintingPointerEvent } from '@slicer/client';
import type { LoadedObject } from '../../useModelLoader';
import { usePaintingController, usePaintingState } from './PaintingProvider';
import { paintingPartMatrix, PaintingResources, type PaintingResource } from './PaintingResources';
import { PaintingProbe } from '../../../../../e2e/PaintingProbe';
declare const __ORCA_E2E__: boolean;

export function paintingPointer(event: Pick<PointerEvent, 'clientX' | 'clientY'>, canvas: HTMLCanvasElement, camera: THREE.Camera): PaintingPointerEvent {
  const rect = canvas.getBoundingClientRect(); camera.updateMatrixWorld();
  return { pointer: [event.clientX, event.clientY], viewport: [rect.left, rect.top, rect.width, rect.height], projection: camera.projectionMatrix.toArray(), view: camera.matrixWorldInverse.toArray() };
}

/** Dedicated painting tree: no ordinary model meshes, selection, drag or BVH on
 * subdivided geometry. Native candidates are separate, explicit manifests. */
export function PaintingGizmoBase({ volumes, resolveColor }: { volumes: readonly LoadedObject[]; resolveColor(volumeId: number, state: number): string }) {
  const owner = usePaintingController()!, state = usePaintingState()!;
  const { camera, gl, invalidate, controls } = useThree();
  const cache = useMemo(() => new PaintingResources(), []);
  const cursorMaterial = useMemo(() => new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), []);
  const [resources, setResources] = useState<PaintingResource[]>([]);
  const [cursor, setCursor] = useState<THREE.Vector3 | null>(null);
  const stateRef = useRef(state); stateRef.current = state;
  const session = state.session;
  useLayoutEffect(() => {
    if (!session || !state.display) { cache.dispose(); setResources([]); return; }
    if (cache.update(state.display, session)) setResources([...cache.resources.values()]);
    invalidate();
  }, [cache, session, state.display, invalidate]);
  useEffect(() => () => cache.dispose(), [cache]);
  useEffect(() => () => cursorMaterial.dispose(), [cursorMaterial]);
  // Cursor meshes borrow the immutable original geometry/BVH; disposal stays
  // with GLVolume. Its hits never determine sample admission or native target.
  const cursorMeshes = useMemo(() => {
    if (!session) return [];
    return volumes.filter((v) => v.buffer.objectId === session.objectId && v.buffer.instanceId === session.instanceId && session.parts.some((p) => p.volumeId === v.buffer.volumeId)).map((v) => {
      const mesh = new THREE.Mesh(v.geometry, cursorMaterial);
      mesh.raycast = acceleratedRaycast;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(paintingPartMatrix(session, v.buffer.volumeId)); mesh.updateMatrixWorld(true);
      return mesh;
    });
  }, [volumes, session?.objectId, session?.instanceId, state.epoch, cursorMaterial]);
  useEffect(() => {
    const canvas = gl.domElement;
    const orbit = controls as unknown as { target?: THREE.Vector3; enabled: boolean; enableDamping: boolean; update(): void } | null;
    const damping = orbit?.enableDamping;
    if (orbit) { orbit.enableDamping = false; orbit.update(); }
    const target = orbit?.target ?? new THREE.Vector3();
    type Gesture = { id: number; mode: 'pending' | 'paint' | 'rotate' | 'pan'; x: number; y: number };
    let gesture: Gesture | null = null;
    let disposed = false;
    const raycaster = new THREE.Raycaster();
    const cursorAt = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), camera);
      const hit = raycaster.intersectObjects(cursorMeshes, false)[0]; setCursor(hit?.point.clone() ?? null); invalidate();
    };
    const stop = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const releaseCapture = () => { const old = gesture; gesture = null; if (old && canvas.hasPointerCapture(old.id)) canvas.releasePointerCapture(old.id); };
    const down = (event: PointerEvent) => {
      stop(event);
      if (gesture || owner.getSnapshot().phase !== 'idle') return;
      canvas.focus(); canvas.setPointerCapture(event.pointerId);
      const mode = event.button === 1 || event.button === 2 ? 'pan' : event.ctrlKey || event.metaKey ? 'rotate' : 'pending';
      const mine: Gesture = { id: event.pointerId, mode, x: event.clientX, y: event.clientY };
      gesture = mine;
      if (mode === 'pending') void owner.press(paintingPointer(event, canvas, camera), event.shiftKey).then((result) => {
        if (disposed || gesture !== mine) return;
        if (result === 'ignored') { releaseCapture(); return; }
        mine.mode = result === 'camera' ? 'rotate' : 'paint';
      });
    };
    const move = (event: PointerEvent) => {
      stop(event); cursorAt(event);
      if (!gesture) { owner.hoverAt(paintingPointer(event, canvas, camera)); return; }
      if (gesture.id !== event.pointerId) return;
      if (gesture.mode === 'pending' || gesture.mode === 'paint') { owner.move(paintingPointer(event, canvas, camera), event.shiftKey); return; }
      if (owner.unfinished) return;
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
      gesture.x = event.clientX; gesture.y = event.clientY;
      if (gesture.mode === 'rotate') rotatePaintingCamera(camera, target, dx, dy, canvas.clientHeight);
      else panPaintingCamera(camera, target, dx, dy, canvas.clientHeight);
      camera.updateMatrixWorld(); invalidate(); setCursor(null); owner.hoverAt();
    };
    const up = (event: PointerEvent) => {
      stop(event);
      if (gesture?.id !== event.pointerId) return;
      if (gesture.mode === 'paint' || gesture.mode === 'pending') owner.release(paintingPointer(event, canvas, camera), event.shiftKey);
      releaseCapture();
    };
    const interrupted = () => { if (gesture?.mode === 'paint' || gesture?.mode === 'pending') owner.release(); releaseCapture(); setCursor(null); };
    const lost = (event: PointerEvent) => { if (gesture?.id === event.pointerId) interrupted(); };
    const leave = () => { setCursor(null); if (!gesture) owner.hoverAt(); };
    const wheel = (event: WheelEvent) => {
      stop(event);
      if (event.ctrlKey || event.metaKey) {
        const { tool, settings } = owner.getSnapshot(), delta = event.deltaY < 0 ? 1 : -1;
        if (tool === 'circle' || tool === 'sphere') owner.setSettings({ radius: Math.max(0.01, settings.radius + delta * 0.2) });
        else if (tool === 'height') owner.setSettings({ height: Math.max(0.01, settings.height + delta * 0.2) });
        else if (tool === 'region' && settings.angle !== null) owner.setSettings({ angle: Math.max(0, Math.min(90, settings.angle + delta)) });
        else if (tool === 'gap') owner.setSettings({ gapArea: Math.max(0, Math.min(5, settings.gapArea + delta * 0.1)) });
      } else if (owner.getSnapshot().phase === 'idle' && !gesture) {
        camera.position.sub(target).multiplyScalar(Math.exp(Math.max(-1, Math.min(1, event.deltaY * 0.001)))).add(target);
        camera.updateMatrixWorld(); setCursor(null); owner.hoverAt();
      }
      invalidate();
    };
    const key = (event: KeyboardEvent) => {
      if ((event.target as Element | null)?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key !== 'Escape') return;
      stop(event);
      if (owner.unfinished) { owner.cancel(); releaseCapture(); }
      else if (!gesture) void owner.close();
      else releaseCapture();
    };
    canvas.addEventListener('pointerdown', down, true); canvas.addEventListener('pointermove', move, true);
    canvas.addEventListener('pointerup', up, true); canvas.addEventListener('pointercancel', interrupted, true);
    canvas.addEventListener('lostpointercapture', lost, true); canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('wheel', wheel, { capture: true, passive: false });
    window.addEventListener('blur', interrupted); window.addEventListener('keydown', key, true);
    return () => {
      disposed = true; interrupted();
      if (orbit) { orbit.update(); orbit.enableDamping = damping ?? true; }
      canvas.removeEventListener('pointerdown', down, true); canvas.removeEventListener('pointermove', move, true);
      canvas.removeEventListener('pointerup', up, true); canvas.removeEventListener('pointercancel', interrupted, true);
      canvas.removeEventListener('lostpointercapture', lost, true); canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('wheel', wheel, true); window.removeEventListener('blur', interrupted); window.removeEventListener('keydown', key, true);
    };
  }, [camera, gl, controls, cursorMeshes, invalidate, owner]);
  if (!session) return null;
  const bounds = new THREE.Box3();
  for (const volume of volumes) if (volume.buffer.objectId === session.objectId && volume.buffer.instanceId === session.instanceId && session.parts.some((p) => p.volumeId === volume.buffer.volumeId)) bounds.union(volume.getWorldBounds());
  const bandSize = bounds.getSize(new THREE.Vector3()), bandCenter = bounds.getCenter(new THREE.Vector3());
  const activeCandidates = new Set(state.display?.candidates.map((c) => c.resourceId));
  return <>
    {__ORCA_E2E__ && <PaintingProbe owner={owner} resources={cache} volumes={volumes} cursor={cursor} />}
    <ambientLight intensity={0.6} /><directionalLight position={[100, 150, 200]} intensity={1.2} />
    {resources.filter((r) => r.source.kind === 'draft' || activeCandidates.has(r.source.resourceId)).map((r) => {
      return <PaintResourceMesh key={r.source.resourceId} resource={r} matrix={paintingPartMatrix(session, r.source.volumeId)} colors={r.source.groups.map(([state]) => resolveColor(r.source.volumeId, state))} />;
    })}
    {cursor && state.tool !== 'gap' && state.tool !== 'region' && <group position={cursor}>
      {state.tool === 'sphere' ? <mesh><sphereGeometry args={[state.settings.radius, 24, 16]} /><meshBasicMaterial color="white" wireframe transparent opacity={0.5} depthTest={false} /></mesh>
        : state.tool === 'circle' ? <mesh quaternion={camera.quaternion}><ringGeometry args={[state.settings.radius * 0.97, state.settings.radius, 64]} /><meshBasicMaterial color="white" side={THREE.DoubleSide} depthTest={false} /></mesh>
          : state.tool === 'height' ? <group position={[bandCenter.x - cursor.x, bandCenter.y - cursor.y, state.settings.height / 2]}><mesh><boxGeometry args={[bandSize.x, bandSize.y, state.settings.height]} /><meshBasicMaterial color="white" wireframe depthTest={false} /></mesh></group>
            : <mesh><sphereGeometry args={[0.4, 8, 8]} /><meshBasicMaterial color="white" depthTest={false} /></mesh>}
    </group>}
  </>;
}
function PaintResourceMesh({ resource, matrix, colors }: { resource: PaintingResource; matrix: THREE.Matrix4; colors: string[] }) {
  const region = resource.source.kind === 'region', overlay = resource.source.kind !== 'draft';
  const materials = useMemo(() => colors.map((color) => new THREE.MeshStandardMaterial({ color: region ? '#ffffff' : color, side: THREE.DoubleSide, transparent: region, opacity: region ? 0.35 : 1, polygonOffset: overlay, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })), [colors.join(','), region, overlay]);
  const contourMaterial = useMemo(() => new THREE.LineBasicMaterial({ color: 'white', depthTest: false }), []);
  useEffect(() => () => materials.forEach((m) => m.dispose()), [materials]);
  useEffect(() => () => contourMaterial.dispose(), [contourMaterial]);
  return <group matrix={matrix} matrixAutoUpdate={false} dispose={null}>
    <mesh geometry={resource.geometry} material={materials} renderOrder={overlay ? 2 : 0} />
    {resource.source.contour.length > 0 && <lineSegments geometry={resource.contour} material={contourMaterial} renderOrder={3} />}
  </group>;
}

export function rotatePaintingCamera(camera: THREE.Camera, target: THREE.Vector3, dx: number, dy: number, height: number): void {
  const alignment = new THREE.Quaternion().setFromUnitVectors(camera.up, new THREE.Vector3(0, 1, 0));
  const offset = camera.position.clone().sub(target).applyQuaternion(alignment);
  const sphere = new THREE.Spherical().setFromVector3(offset);
  sphere.theta -= 2 * Math.PI * dx / height; sphere.phi -= 2 * Math.PI * dy / height; sphere.makeSafe();
  camera.position.copy(new THREE.Vector3().setFromSpherical(sphere).applyQuaternion(alignment.invert()).add(target)); camera.lookAt(target);
}
export function panPaintingCamera(camera: THREE.Camera, target: THREE.Vector3, dx: number, dy: number, height: number): void {
  const distance = camera.position.distanceTo(target);
  const fov = (camera as THREE.PerspectiveCamera).fov ?? 45;
  const factor = 2 * distance * Math.tan(fov * Math.PI / 360) / height;
  const delta = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(-dx * factor)
    .add(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).multiplyScalar(dy * factor));
  camera.position.add(delta); target.add(delta);
}
