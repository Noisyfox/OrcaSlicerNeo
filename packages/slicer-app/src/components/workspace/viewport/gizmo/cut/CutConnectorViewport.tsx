import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { Group, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { normalOf, quaternionOf, type CutSession } from './CutSession';

export function CutConnectorViewport({ cut }: { cut: CutSession }) {
  const { gl, camera } = useThree();
  const group = useRef<Group>(null), editing = !!cut.editor;
  useEffect(() => {
    if (!editing) return;
    const canvas = gl.domElement, picker = new Raycaster();
    let press: { id: number; x: number; y: number; index: number | null; moved: boolean } | null = null;
    function point(e: PointerEvent) {
      if (!cut.draft) return null;
      const rect = canvas.getBoundingClientRect();
      picker.setFromCamera(new Vector2(2*(e.clientX-rect.left)/rect.width-1, 1-2*(e.clientY-rect.top)/rect.height), camera);
      return picker.ray.intersectPlane(new Plane().setFromNormalAndCoplanarPoint(normalOf(cut.draft),
        new Vector3(...cut.draft.center)), new Vector3());
    }
    const down = (e: PointerEvent) => {
      if (e.button || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !point(e) || press) return;
      const hit = group.current && picker.intersectObject(group.current)[0];
      press = { id: e.pointerId, x:e.clientX, y:e.clientY, index: hit?.object.userData.connector ?? null, moved: false };
      if (press.index !== null) cut.selectConnector(press.index);
      e.preventDefault(); e.stopImmediatePropagation(); canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.id) return;
      e.stopImmediatePropagation();
      press.moved ||= Math.hypot(e.clientX-press.x, e.clientY-press.y) > 4;
      const p = point(e);
      if (press.moved && press.index !== null && p) cut.changeConnector({ position:p.toArray() });
    };
    const release = () => {
      const id = press?.id; press = null;
      if (id !== undefined && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    };
    const up = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.id) return;
      move(e);
      const p = point(e);
      if (!press.moved && press.index === null && p) cut.addConnector(p.toArray());
      release();
    };
    canvas.addEventListener('pointerdown',down,true); canvas.addEventListener('pointermove',move,true);
    canvas.addEventListener('pointerup',up,true); canvas.addEventListener('pointercancel',release,true);
    canvas.addEventListener('lostpointercapture',release);
    return () => {
      release(); canvas.removeEventListener('pointerdown',down,true); canvas.removeEventListener('pointermove',move,true);
      canvas.removeEventListener('pointerup',up,true); canvas.removeEventListener('pointercancel',release,true);
      canvas.removeEventListener('lostpointercapture',release);
    };
  }, [cut, editing, camera, gl]);
  if (!cut.draft) return null;
  const q = quaternionOf(cut.draft);
  return <group ref={group}>{cut.connectors?.map((c,i) =>
    <group key={i} position={c.position} quaternion={q}><group rotation={[0,0,-c.angle*Math.PI/180]}>
      <mesh position={[0,0,c.type === 'dowel' ? 0 : c.depth/2]} rotation={[Math.PI/2,0,0]} userData={{ connector:i }} renderOrder={6}>
        <cylinderGeometry args={[c.diameter*(c.style === 'frustum' ? 0.38 : 0.5),c.diameter/2,
          c.type === 'dowel' ? c.depth*2 : c.depth, { triangle:3, square:4, hexagon:6, circle:48 }[c.shape]]}/>
        <meshBasicMaterial color={cut.invalidConnectors?.includes(i) ? '#e74639' : cut.editor?.selected === i ? '#ffce55' : '#63b45a'}
          depthTest={false} transparent opacity={0.88}/>
      </mesh></group></group>)}</group>;
}
