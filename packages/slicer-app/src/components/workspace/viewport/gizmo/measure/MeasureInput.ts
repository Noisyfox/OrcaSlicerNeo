import * as THREE from 'three';
import { panCamera, rotateCameraFromPointer } from '../../cameraNavigation';
import type { MeasurePointerEvent } from '@slicer/client';
import type { MeasureController } from './MeasureController';
import { hitsMeasureGripper } from './measureHitTest';

function pointerSnapshot(event: Pick<PointerEvent, 'clientX' | 'clientY'>, canvas: HTMLCanvasElement, camera: THREE.Camera): MeasurePointerEvent {
  const rect = canvas.getBoundingClientRect(); camera.updateMatrixWorld();
  return { pointer: [event.clientX, event.clientY], viewport: [rect.left, rect.top, rect.width, rect.height],
    projection: camera.projectionMatrix.toArray(), view: camera.matrixWorldInverse.toArray() };
}

interface MeasureInputPorts {
  canvas: HTMLCanvasElement;
  camera: THREE.Camera;
  controls: { target: THREE.Vector3; enableDamping: boolean; update(): void };
  controller: MeasureController;
  /** Reliable hits of the visible source mesh or offset plane overlay. */
  hitsSurface(event: PointerEvent): boolean;
  pivot(): THREE.Vector3;
  invalidate(): void;
}

/** Install one synchronous pointer owner. Only the native request resolves a
 * feature; the local hit check decides whether this press belongs to the tool
 * or the camera before either can move. */
export function installMeasureInput({ canvas, camera, controls, controller, hitsSurface, pivot, invalidate }: MeasureInputPorts): () => void {
  const damping = controls.enableDamping;
  controls.enableDamping = false; controls.update();
  type Gesture = { id: number; mode: 'feature' | 'rotate' | 'pan'; x: number; y: number; pivot: THREE.Vector3 };
  let gesture: Gesture | null = null;
  let lastPoint: { clientX: number; clientY: number } | null = null;
  const stop = (event: Event) => { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); };
  const release = () => {
    const old = gesture; gesture = null;
    if (old && canvas.hasPointerCapture(old.id)) canvas.releasePointerCapture(old.id);
  };
  const hover = (event: Pick<PointerEvent, 'clientX' | 'clientY'>) => controller.hover(pointerSnapshot(event, canvas, camera));
  const down = (event: PointerEvent) => {
    stop(event);
    if (gesture || (event.button !== 0 && event.button !== 1 && event.button !== 2)) return;
    canvas.focus(); canvas.setPointerCapture(event.pointerId);
    lastPoint = { clientX: event.clientX, clientY: event.clientY };
    let mode: Gesture['mode'] = event.button === 1 || event.button === 2 ? 'pan' : 'rotate';
    if (event.button === 0 && !event.ctrlKey && !event.metaKey) {
      const rect = canvas.getBoundingClientRect();
      const snapshot = controller.getSnapshot();
      const gripper = hitsMeasureGripper({ x: event.clientX, y: event.clientY }, camera, rect, snapshot.display, snapshot.status);
      if (gripper || hitsSurface(event)) {
        mode = 'feature';
        controller.click(pointerSnapshot(event, canvas, camera), event.shiftKey);
      }
    }
    if (mode !== 'feature') controller.invalidateHover();
    gesture = { id: event.pointerId, mode, x: event.clientX, y: event.clientY, pivot: pivot().clone() };
  };
  const move = (event: PointerEvent) => {
    stop(event); lastPoint = { clientX: event.clientX, clientY: event.clientY };
    if (!gesture) { hover(event); return; }
    if (gesture.id !== event.pointerId || gesture.mode === 'feature') return;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    gesture.x = event.clientX; gesture.y = event.clientY;
    if (gesture.mode === 'rotate') rotateCameraFromPointer(camera, controls.target, gesture.pivot, dx, dy, canvas.clientHeight);
    else panCamera(camera, controls.target, dx, dy, canvas.clientHeight);
    camera.updateMatrixWorld(); invalidate();
  };
  const up = (event: PointerEvent) => {
    stop(event);
    if (gesture?.id !== event.pointerId) return;
    release(); hover(event);
  };
  const interrupted = () => release();
  const lost = (event: PointerEvent) => { if (gesture?.id === event.pointerId) release(); };
  const leave = () => {
    if (gesture) return;
    controller.invalidateHover();
    const rect = canvas.getBoundingClientRect();
    hover({ clientX: rect.left - 1, clientY: rect.top - 1 });
  };
  const wheel = (event: WheelEvent) => {
    stop(event);
    if (gesture) return;
    controller.invalidateHover();
    camera.position.sub(controls.target).multiplyScalar(Math.exp(Math.max(-1, Math.min(1, event.deltaY * 0.001)))).add(controls.target);
    camera.updateMatrixWorld(); invalidate();
    if (lastPoint) hover(lastPoint);
  };
  canvas.addEventListener('pointerdown', down, true); canvas.addEventListener('pointermove', move, true);
  canvas.addEventListener('pointerup', up, true); canvas.addEventListener('pointercancel', interrupted, true);
  canvas.addEventListener('lostpointercapture', lost, true); canvas.addEventListener('pointerleave', leave);
  canvas.addEventListener('wheel', wheel, { capture: true, passive: false });
  window.addEventListener('blur', interrupted);
  return () => {
    release(); controls.update(); controls.enableDamping = damping;
    canvas.removeEventListener('pointerdown', down, true); canvas.removeEventListener('pointermove', move, true);
    canvas.removeEventListener('pointerup', up, true); canvas.removeEventListener('pointercancel', interrupted, true);
    canvas.removeEventListener('lostpointercapture', lost, true); canvas.removeEventListener('pointerleave', leave);
    canvas.removeEventListener('wheel', wheel, true); window.removeEventListener('blur', interrupted);
  };
}
