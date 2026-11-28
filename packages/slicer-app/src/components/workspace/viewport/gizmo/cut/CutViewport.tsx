import { useEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { DoubleSide, Group, Plane, Quaternion, Raycaster, Vector2, Vector3 } from 'three';
import type { SceneInteractionController } from '../../SceneInteractionController';
import { useSceneInteractionVersion } from '../../SceneInteractionContext';
import { drawnPlane, normalOf, quaternionOf, rotationOf, type CutPose } from './CutSession';

import { CutPreview } from './CutPreview';
import { CutVertices } from './CutVertices';
import { ScreenMarker } from '../measure/MeasureViewport';
import { useObjectListStore } from '../../../objectList/useObjectListStore';

type Handle = 'translate' | 'x' | 'y' | 'line';
export function CutViewport({ scene }: { scene: SceneInteractionController }) {
  useSceneInteractionVersion(scene);
  const { gl, camera, invalidate } = useThree();
  const group = useRef<Group>(null);
  const active = scene.gizmo === 'cut';
  const cut = scene.cut, draft = cut.draft, target = cut.target;
  const structure = useObjectListStore(s => s.structure);
  const volumes = useMemo(() => {
    const object = structure.find(o => o.id === target?.objectId);
    return target ? scene.selectedVolumes().filter(v => object?.volumes.some(part =>
      part.id === v.buffer.volumeId && part.type === 'model_part')) : [];
  }, [structure, target, scene]);
  const vertices = useMemo(() => new CutVertices(volumes), [volumes]);
  useEffect(() => () => vertices.dispose(), [vertices]);
  const [hover, setHover] = useState<Vector3 | null>(null);
  useEffect(() => { setHover(null); }, [vertices]);
  useEffect(() => { invalidate(); }, [draft, active, invalidate]);
  useEffect(() => {
    if (!active) return;
    const canvas = gl.domElement;
    const raycaster = new Raycaster();
    function pointerRay(event: PointerEvent) {
      const rect = canvas.getBoundingClientRect();
      raycaster.setFromCamera(new Vector2(2 * (event.clientX - rect.left) / rect.width - 1,
        1 - 2 * (event.clientY - rect.top) / rect.height), camera);
      return raycaster.ray;
    }
    let drag: { id: number; kind: Handle; pose: CutPose; plane: Plane; axis: Vector3; from: Vector3;
      x: number; y: number; radius: number } | null = null;
    let click: { id: number; point: Vector3; x: number; y: number } | null = null;
    const pick = (event: PointerEvent) => vertices.pick(event, canvas.getBoundingClientRect(), camera);
    const down = (event: PointerEvent) => {
      if (!group.current || !cut.draft || !cut.target || cut.busy || drag || event.button !== 0 ||
          event.altKey || event.ctrlKey || event.metaKey) return;
      const point = !event.shiftKey && pick(event);
      if (point) click = { id: event.pointerId, x: event.clientX, y: event.clientY, point };
      const ray = pointerRay(event);
      group.current.updateWorldMatrix(true, true);
      const hits = raycaster.intersectObject(group.current).filter(h => h.object.userData.cutHandle);
      const hit = hits.find(h => h.object.userData.cutHandle === 'x' || h.object.userData.cutHandle === 'y') ?? hits[0];
      const kind: Handle | undefined = event.shiftKey ? 'line' : hit?.object.userData.cutHandle;
      if (!kind) return;
      const pose = cut.draft;
      const center = new Vector3(...pose.center), normal = normalOf(pose);
      const axis = kind === 'x' || kind === 'y' ? new Vector3(kind === 'x' ? 1 : 0, kind === 'y' ? 1 : 0, 0)
        .applyQuaternion(quaternionOf(pose)) : normal;
      const view = camera.getWorldDirection(new Vector3());
      const facing = kind === 'line' ? view : kind === 'translate'
        ? view.clone().addScaledVector(normal, -view.dot(normal)) : axis.clone();
      if (facing.lengthSq() < 1e-8) facing.copy(view);
      const plane = new Plane().setFromNormalAndCoplanarPoint(facing.normalize(), center);
      const from = ray.intersectPlane(plane, new Vector3()) ?? hit?.point.clone() ?? center;
      if (!scene.claimExternalPointer()) return;
      event.preventDefault(); event.stopImmediatePropagation();
      canvas.closest<HTMLElement>('[data-testid="viewport"]')?.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, kind, pose, plane, axis, from, x: event.clientX, y: event.clientY, radius: cut.target.radius };
      cut.begin();
    };
    const move = (event: PointerEvent) => {
      if (click && Math.hypot(event.clientX - click.x, event.clientY - click.y) > 4) click = null;
      if (!drag) {
        setHover(event.buttons || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey ? null : pick(event));
        return;
      }
      if (event.pointerId !== drag.id || click) return;
      event.stopImmediatePropagation();
      const { pose, axis, from, plane, kind } = drag;
      const center = new Vector3(...pose.center);
      const point = pointerRay(event).intersectPlane(plane, new Vector3());
      if (kind === 'line') {
        if (!point || Math.hypot(event.clientX - drag.x, event.clientY - drag.y) <= 4) return;
        const drawn = drawnPlane(pose, from, point, camera.getWorldDirection(new Vector3()));
        if (drawn) cut.update(drawn);
      } else if (kind === 'translate') {
        const facing = Math.abs(camera.getWorldDirection(new Vector3()).dot(axis));
        const distance = point && facing < 0.999 ? point.sub(from).dot(axis)
          : (drag.y - event.clientY) * drag.radius * 2 / canvas.clientHeight;
        cut.move(distance, pose);
      } else {
        const a = from.clone().sub(center).normalize(), b = point?.sub(center).normalize();
        const angle = b && Math.abs(pointerRay(event).direction.dot(axis)) > 0.05
          ? Math.atan2(axis.dot(a.clone().cross(b)), a.dot(b)) : (event.clientX-drag.x + drag.y-event.clientY) * 0.012;
        cut.update({ rotation: rotationOf(new Quaternion().setFromAxisAngle(axis, angle).multiply(quaternionOf(pose))) });
      }
    };
    const finish = (cancel: boolean) => {
      if (!drag) return;
      const id = drag.id;
      drag = null;
      cut.finish(cancel); scene.releaseExternalPointer();
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    };
    const up = (event: PointerEvent) => {
      if (cut.draft && click?.id === event.pointerId &&
          Math.hypot(event.clientX - click.x, event.clientY - click.y) <= 4) {
        cut.move(click.point.clone().sub(new Vector3(...cut.draft.center)).dot(normalOf(cut.draft)));
        click = null;
        if (drag) { event.stopImmediatePropagation(); finish(false); }
        return;
      }
      click = null;
      if (event.pointerId !== drag?.id) return;
      move(event); event.stopImmediatePropagation(); finish(false);
    };
    const cancel = () => { click = null; finish(true); };
    const leave = () => setHover(null);
    canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('pointerdown', down, true);
    canvas.addEventListener('pointermove', move, true);
    canvas.addEventListener('pointerup', up, true);
    canvas.addEventListener('pointercancel', cancel, true);
    canvas.addEventListener('lostpointercapture', cancel);
    return () => {
      cancel();
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('pointerdown', down, true);
      canvas.removeEventListener('pointermove', move, true);
      canvas.removeEventListener('pointerup', up, true);
      canvas.removeEventListener('pointercancel', cancel, true);
      canvas.removeEventListener('lostpointercapture', cancel);
    };
  }, [active, camera, gl, cut, scene, vertices]);
  if (!active || !draft || !target) return null;
  const r = target.radius;
  return <>
    <CutPreview target={target} pose={draft} revision={cut.revision} volumes={volumes}/>
    {hover && <ScreenMarker position={hover.toArray()} color="#72e8ff"/>}
    <group ref={group} position={draft.center} quaternion={quaternionOf(draft)}>
    <mesh userData={{ cutHandle: 'translate' }} renderOrder={2}><planeGeometry args={[r*2,r*2]}/>
      <meshBasicMaterial transparent opacity={0.18} color="#68b4ed" depthWrite={false} side={DoubleSide}/></mesh>
    <mesh position={[0,0,r*0.52]} rotation={[Math.PI/2,0,0]} userData={{ cutHandle: 'translate' }} renderOrder={4}>
      <cylinderGeometry args={[r*0.018,r*0.018,r,12]}/><meshBasicMaterial color="#2898ed" depthTest={false}/></mesh>
    <mesh position={[0,0,r]} rotation={[Math.PI/2,0,0]} userData={{ cutHandle: 'translate' }} renderOrder={4}>
      <coneGeometry args={[r*0.065,r*0.18,16]}/><meshBasicMaterial color="#2898ed" depthTest={false}/></mesh>
    {(['x','y'] as const).map(axis => <mesh key={axis} rotation={axis === 'x' ? [0,Math.PI/2,0] : [Math.PI/2,0,0]}
      userData={{ cutHandle: axis }} renderOrder={3}>
      <torusGeometry args={[r*0.65,r*0.018,8,80]}/>
      <meshBasicMaterial color={axis === 'x' ? '#d75042' : '#429855'} depthTest={false}/></mesh>)}
  </group></>;
}
