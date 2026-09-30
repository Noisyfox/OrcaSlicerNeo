import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { acceleratedRaycast } from 'three-mesh-bvh';
import type { PaintingPointerEvent, PaintingSessionMetadata } from '@slicer/client';
import type { LoadedObject } from '../../useModelLoader';
import { usePaintingController, usePaintingState } from './PaintingProvider';
import { paintingPartMatrix, PaintingResources, type PaintingResource } from './PaintingResources';
import { PaintingProbe } from '../../../../../e2e/PaintingProbe';
import type { PaintingDisplay } from './PaintingController';
declare const __ORCA_E2E__: boolean;

export function paintingPointer(event: Pick<PointerEvent, 'clientX' | 'clientY'>, canvas: HTMLCanvasElement, camera: THREE.Camera): PaintingPointerEvent {
  const rect = canvas.getBoundingClientRect(); camera.updateMatrixWorld();
  return { pointer: [event.clientX, event.clientY], viewport: [rect.left, rect.top, rect.width, rect.height], projection: camera.projectionMatrix.toArray(), view: camera.matrixWorldInverse.toArray() };
}

/** Borrowed cursor meshes retain identity across equivalent native metadata
 * reads. This also preserves their memoized tight bounds and input listeners. */
export function paintingCursorMeshes(previous: THREE.Mesh[], volumes: readonly LoadedObject[], session: PaintingSessionMetadata | undefined, material: THREE.Material): THREE.Mesh[] {
  const parts = session ? volumes.filter((v) => v.buffer.objectId === session.objectId && v.buffer.instanceId === session.instanceId && session.parts.some((p) => p.volumeId === v.buffer.volumeId)) : [];
  const matrices = parts.map((v) => paintingPartMatrix(session!, v.buffer.volumeId));
  if (previous.length === parts.length && previous.every((mesh, i) => mesh.geometry === parts[i].geometry && mesh.matrix.equals(matrices[i]))) return previous;
  return parts.map((v, i) => {
    const existing = previous[i];
    if (existing?.geometry === v.geometry && existing.matrix.equals(matrices[i])) return existing;
    const mesh = new THREE.Mesh(v.geometry, material);
    mesh.raycast = acceleratedRaycast; mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(matrices[i]); mesh.updateMatrixWorld(true);
    return mesh;
  });
}

export function paintingModelBounds(meshes: readonly THREE.Mesh[]): THREE.Box3 {
  const box = new THREE.Box3(), vertex = new THREE.Vector3();
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) box.expandByPoint(vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrix));
  }
  return box;
}

/** Dedicated painting tree: no ordinary model meshes, selection, drag or BVH on
 * subdivided geometry. Native candidates are separate, explicit manifests. */
export function PaintingGizmoBase({ volumes, resolveColor, openingVisual }: { volumes: readonly LoadedObject[]; resolveColor(display: PaintingDisplay, volumeId: number, state: number): string; openingVisual: ReactNode }) {
  const owner = usePaintingController()!, state = usePaintingState()!;
  const { camera, gl, invalidate, controls } = useThree();
  const cache = useMemo(() => new PaintingResources(), []);
  const cursorMaterial = useMemo(() => new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), []);
  const borrowedCursorMeshes = useRef<THREE.Mesh[]>([]);
  const [visual, setVisual] = useState<{ display: PaintingDisplay; resources: PaintingResource[] } | null>(null);
  const [cursor, setCursor] = useState<THREE.Vector3 | null>(null);
  const session = visual?.display.session;
  useLayoutEffect(() => {
    if (!state.display) return;
    try {
      if (cache.update(state.display, state.display.session)) setVisual({ display: state.display, resources: [...cache.resources.values()] });
    } catch (error) { owner.reportDisplayError(error); }
    invalidate();
  }, [cache, state.display, invalidate, owner]);
  useEffect(() => () => cache.dispose(), [cache]);
  useEffect(() => () => cursorMaterial.dispose(), [cursorMaterial]);
  // Cursor meshes borrow the immutable original geometry/BVH; disposal stays
  // with GLVolume. Its hits never determine sample admission or native target.
  const cursorMeshes = useMemo(() => {
    borrowedCursorMeshes.current = paintingCursorMeshes(borrowedCursorMeshes.current, volumes, session, cursorMaterial);
    return borrowedCursorMeshes.current;
  }, [volumes, session?.objectId, session?.instanceId, session?.instanceTransform, session?.parts, cursorMaterial]);
  const cursorMeshesRef = useRef(cursorMeshes); cursorMeshesRef.current = cursorMeshes;
  // Bounds follow only the complete displayed target, using original solid
  // vertices and its displayed matrices. Equivalent RGB/stroke receipts reuse
  // cursorMeshes, so neither vertex scans nor the orbit centre change.
  const bounds = useMemo(() => paintingModelBounds(cursorMeshes), [cursorMeshes]);
  const pivot = useMemo(() => bounds.isEmpty() ? null : bounds.getCenter(new THREE.Vector3()), [bounds]);
  const pivotRef = useRef(pivot); pivotRef.current = pivot;
  useEffect(() => {
    const canvas = gl.domElement;
    const orbit = controls as unknown as { target: THREE.Vector3; enableDamping: boolean; update(): void } | null;
    if (!orbit) return;
    const damping = orbit.enableDamping;
    orbit.enableDamping = false; orbit.update();
    const target = orbit.target;
    type Gesture = { id: number; mode: 'pending' | 'paint' | 'rotate' | 'pan'; x: number; y: number };
    let gesture: Gesture | null = null;
    let disposed = false;
    const raycaster = new THREE.Raycaster();
    const cursorAt = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), camera);
      const hit = raycaster.intersectObjects(cursorMeshesRef.current, false)[0]; setCursor(hit?.point.clone() ?? null); invalidate();
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
      if (gesture.mode === 'rotate') {
        if (!pivotRef.current) return;
        rotatePaintingCamera(camera, target, pivotRef.current, dx, dy, canvas.clientHeight);
      }
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
      orbit.update(); orbit.enableDamping = damping;
      canvas.removeEventListener('pointerdown', down, true); canvas.removeEventListener('pointermove', move, true);
      canvas.removeEventListener('pointerup', up, true); canvas.removeEventListener('pointercancel', interrupted, true);
      canvas.removeEventListener('lostpointercapture', lost, true); canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('wheel', wheel, true); window.removeEventListener('blur', interrupted); window.removeEventListener('keydown', key, true);
    };
  }, [camera, gl, controls, invalidate, owner]);
  const bandSize = bounds.getSize(new THREE.Vector3()), bandCenter = bounds.getCenter(new THREE.Vector3());
  const activeCandidates = new Set(visual?.display.candidates.map((c) => c.resourceId));
  return <>
    {__ORCA_E2E__ && <PaintingProbe owner={owner} resources={cache} volumes={volumes} cursor={cursor} pivot={pivot} />}
    <ambientLight intensity={0.6} /><directionalLight position={[100, 150, 200]} intensity={1.2} />
    {visual ? visual.resources.filter((r) => r.source.kind === 'draft' || activeCandidates.has(r.source.resourceId)).map((r) => {
      return <PaintResourceMesh key={r.source.resourceId} resource={r} targetName={__ORCA_E2E__ ? `painting-model-${visual.display.session.objectId}-${visual.display.session.instanceId}` : ''} matrix={paintingPartMatrix(visual.display.session, r.source.volumeId)} colors={r.source.groups.map(([state]) => resolveColor(visual.display, r.source.volumeId, state))} />;
    }) : openingVisual}
    {cursor && state.tool !== 'gap' && state.tool !== 'region' && <group position={cursor}>
      {state.tool === 'sphere' ? <mesh><sphereGeometry args={[state.settings.radius, 24, 16]} /><meshBasicMaterial color="white" wireframe transparent opacity={0.5} depthTest={false} /></mesh>
        : state.tool === 'circle' ? <mesh quaternion={camera.quaternion}><ringGeometry args={[state.settings.radius * 0.97, state.settings.radius, 64]} /><meshBasicMaterial color="white" side={THREE.DoubleSide} depthTest={false} /></mesh>
          : state.tool === 'height' ? <group position={[bandCenter.x - cursor.x, bandCenter.y - cursor.y, state.settings.height / 2]}><mesh><boxGeometry args={[bandSize.x, bandSize.y, state.settings.height]} /><meshBasicMaterial color="white" wireframe depthTest={false} /></mesh></group>
            : <mesh><sphereGeometry args={[0.4, 8, 8]} /><meshBasicMaterial color="white" depthTest={false} /></mesh>}
    </group>}
  </>;
}
function PaintResourceMesh({ resource, matrix, colors, targetName }: { resource: PaintingResource; matrix: THREE.Matrix4; colors: string[]; targetName: string }) {
  const region = resource.source.kind === 'region', overlay = resource.source.kind !== 'draft';
  const materials = useMemo(() => colors.map((color) => new THREE.MeshStandardMaterial({ color: region ? '#ffffff' : color, side: THREE.DoubleSide, transparent: region, opacity: region ? 0.35 : 1, polygonOffset: overlay, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })), [colors.join(','), region, overlay]);
  const contourMaterial = useMemo(() => new THREE.LineBasicMaterial({ color: 'white', depthTest: false }), []);
  useEffect(() => () => materials.forEach((m) => m.dispose()), [materials]);
  useEffect(() => () => contourMaterial.dispose(), [contourMaterial]);
  return <group matrix={matrix} matrixAutoUpdate={false} dispose={null}>
    <mesh name={__ORCA_E2E__ ? overlay ? 'painting-candidate' : targetName : undefined} geometry={resource.geometry} material={materials} renderOrder={overlay ? 2 : 0} />
    {resource.source.contour.length > 0 && <lineSegments geometry={resource.contour} material={contourMaterial} renderOrder={3} />}
  </group>;
}

export function rotatePaintingCamera(camera: THREE.Camera, target: THREE.Vector3, pivot: THREE.Vector3, dx: number, dy: number, height: number): void {
  // Inverse of Orca's view rotation: world-Z azimuth and camera-right zenith.
  // Retain Neo's safe polar range from the view direction, rather than the
  // pivot offset (which differs after pan). Apply the same rigid transform to
  // navigation's target so OrbitControls retains the existing framing.
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const backward = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
  const polar = Math.acos(THREE.MathUtils.clamp(backward.z, -1, 1));
  const zenith = THREE.MathUtils.clamp(polar - 2 * Math.PI * dy / height, 1e-6, Math.PI - 1e-6) - polar;
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -2 * Math.PI * dx / height)
    .multiply(new THREE.Quaternion().setFromAxisAngle(right, zenith));
  camera.position.sub(pivot).applyQuaternion(rotation).add(pivot);
  camera.quaternion.premultiply(rotation);
  target.sub(pivot).applyQuaternion(rotation).add(pivot);
}
export function panPaintingCamera(camera: THREE.Camera, target: THREE.Vector3, dx: number, dy: number, height: number): void {
  const distance = camera.position.distanceTo(target);
  const fov = (camera as THREE.PerspectiveCamera).fov ?? 45;
  const factor = 2 * distance * Math.tan(fov * Math.PI / 360) / height;
  const delta = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(-dx * factor)
    .add(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).multiplyScalar(dy * factor));
  camera.position.add(delta); target.add(delta);
}
