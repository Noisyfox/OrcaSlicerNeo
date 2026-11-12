// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { OrbitControls } from 'three-stdlib';
import type { PlateSessionSnapshot } from '@slicer/client';
import { cameraOrbitPivot, installCameraOrbitPivot, panCamera, rotateCameraFromPointer } from './cameraNavigation';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); vi.restoreAllMocks(); });
const near = (a: number[], b: number[], digits = 8) => a.forEach((n, i) => expect(n).toBeCloseTo(b[i], digits));
const bounds = { minX: -20, minY: -40, maxX: 180, maxY: 260, width: 200, depth: 300, centerX: 80, centerY: 110 };
const session: PlateSessionSnapshot = { ok: true, version: 1, instances: [], currentPlateId: 'second', plates: [
  { plateId: 'first', name: 'Plate 1', displayIndex: 0, origin: [0, 0, 0] }, { plateId: 'second', name: 'Plate 2', displayIndex: 1, origin: [240, -330, 5] },
] };

function fixture(resolvePivot = () => new THREE.Vector3(100, 40, 20), adapted = true) {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  Object.defineProperties(canvas, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  canvas.releasePointerCapture = () => {};
  const camera = new THREE.PerspectiveCamera(45, 4 / 3, 0.1, 2000);
  camera.up.set(0, 0, 1); camera.position.set(80, -290, 300);
  const controls = new OrbitControls(camera);
  controls.target.set(20, 30, 0); camera.lookAt(controls.target); camera.updateMatrixWorld();
  controls.enableDamping = true;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
  controls.update();
  const adapter = adapted ? installCameraOrbitPivot(controls, canvas, resolvePivot) : null;
  controls.connect(canvas);
  cleanups.push(() => { adapter?.dispose(); controls.dispose(); canvas.remove(); });
  const pointer = (type: string, x: number, y: number, button = 0, options: { pointerId?: number; pointerType?: string } = {}) => {
    const event = new MouseEvent(type, { clientX: x, clientY: y, button, bubbles: true, cancelable: true });
    Object.defineProperties(event, { pointerId: { value: options.pointerId ?? 1 }, pointerType: { value: options.pointerType ?? 'mouse' } });
    canvas.dispatchEvent(event);
  };
  const pose = () => [...camera.position.toArray(), ...camera.quaternion.toArray(), ...controls.target.toArray()];
  const point = (p: THREE.Vector3) => { camera.updateMatrixWorld(); return p.clone().applyMatrix4(camera.matrixWorldInverse).toArray(); };
  const settle = () => { for (let i = 0; i < 600; ++i) { if ((controls.update() as unknown) === false) return; } throw new Error('camera inertia did not settle'); };
  return { camera, canvas, controls, adapter, pointer, pose, point, settle };
}

describe('camera orbit pivot policy', () => {
  it('uses a valid selection, including the world origin, before the current plate', () => {
    const selectionPivot = vi.fn(() => new THREE.Vector3(10, 20, 30));
    expect(cameraOrbitPivot('prepare', { selectionPivot }, bounds, session).toArray()).toEqual([10, 20, 30]);
    selectionPivot.mockReturnValue(new THREE.Vector3());
    expect(cameraOrbitPivot('prepare', { selectionPivot }, bounds, session).toArray()).toEqual([0, 0, 0]);
  });
  it('uses the current plate footprint at its world origin for empty selection and Preview', () => {
    expect(cameraOrbitPivot('prepare', { selectionPivot: () => null }, bounds, session).toArray()).toEqual([320, -220, 5]);
    const selectionPivot = vi.fn(() => new THREE.Vector3(10, 20, 30));
    expect(cameraOrbitPivot('preview', { selectionPivot }, bounds, session).toArray()).toEqual([320, -220, 5]);
    expect(selectionPivot).not.toHaveBeenCalled();
    expect(cameraOrbitPivot('prepare', { selectionPivot: () => null }, bounds, null).toArray()).toEqual([80, 110, 0]);
  });
});

describe('independent pivot over real OrbitControls input and damping', () => {
  it('preserves the panned pivot projection during input, emitted changes and the entire inertial tail', () => {
    const pivot = new THREE.Vector3(100, 40, 20), f = fixture(() => pivot);
    panCamera(f.camera, f.controls.target, 170, -110, 600); f.controls.update();
    const before = f.point(pivot), projected = pivot.clone().project(f.camera).toArray();
    const pose = f.pose(), distance = f.camera.position.distanceTo(f.controls.target);
    const emitted: number[][] = []; f.controls.addEventListener('change', () => emitted.push(f.point(pivot)));
    f.pointer('pointerdown', 300, 300); near(f.pose(), pose);
    f.pointer('pointermove', 340, 325); expect(f.pose()).not.toEqual(pose); near(f.point(pivot), before);
    f.pointer('pointerup', 340, 325);
    const released = f.pose(); f.controls.update(); expect(f.pose()).not.toEqual(released);
    for (let i = 0; i < 120; ++i) { f.controls.update(); near(f.point(pivot), before); }
    for (let i = 0; i < 600; ++i) f.controls.update();
    near(pivot.clone().project(f.camera).toArray(), projected);
    expect(f.camera.position.distanceTo(f.controls.target)).toBeCloseTo(distance, 8);
    expect(emitted.length).toBeGreaterThan(10); emitted.forEach(point => near(point, before));
    const settled = f.pose(); for (let i = 0; i < 10; ++i) f.controls.update(); near(f.pose(), settled);
  });
  it('matches the existing painting rotation for an undamped pointer delta', () => {
    const pivot = new THREE.Vector3(100, 40, 20), f = fixture(() => pivot);
    const expected = f.camera.clone(), target = f.controls.target.clone();
    rotateCameraFromPointer(expected, target, pivot, 40, 25, 600);
    f.controls.enableDamping = false;
    f.pointer('pointerdown', 300, 300); f.pointer('pointermove', 340, 325); f.pointer('pointerup', 340, 325);
    near(f.camera.position.toArray(), expected.position.toArray()); near(f.camera.quaternion.toArray(), expected.quaternion.toArray()); near(f.controls.target.toArray(), target.toArray());
  });
  it('retains the stock angular damping trajectory and safe polar range', () => {
    const f = fixture(), stock = fixture(undefined, false);
    for (const item of [f, stock]) { item.pointer('pointerdown', 300, 300); item.pointer('pointermove', 350, -2000); item.pointer('pointerup', 350, -2000); }
    for (let i = 0; i < 160; ++i) {
      f.controls.update(); stock.controls.update(); near(f.camera.quaternion.toArray(), stock.camera.quaternion.toArray(), 7);
      expect(f.controls.getPolarAngle()).toBeGreaterThan(0); expect(f.controls.getPolarAngle()).toBeLessThan(Math.PI);
    }
  });
  it('freezes one pivot through a drag and inertia, then reads the latest pivot on the next gesture without reframing', () => {
    let pivot = new THREE.Vector3(100, 40, 20);
    const resolve = vi.fn(() => pivot), f = fixture(resolve), old = pivot.clone(), before = f.point(old);
    f.pointer('pointerdown', 300, 300); f.pointer('pointermove', 320, 310);
    pivot = new THREE.Vector3(-70, 180, 0);
    f.pointer('pointermove', 340, 325); f.pointer('pointerup', 340, 325); f.settle(); near(f.point(old), before);
    expect(resolve).toHaveBeenCalledTimes(1);
    const pose = f.pose(), nextPoint = f.point(pivot);
    f.pointer('pointerdown', 300, 300); near(f.pose(), pose);
    f.pointer('pointermove', 320, 310); f.pointer('pointerup', 320, 310); f.settle(); near(f.point(pivot), nextPoint);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
  it.each([1, 2])('retains stock pan and wheel zoom for mouse button %s', button => {
    const f = fixture(), stock = fixture(undefined, false);
    for (const item of [f, stock]) {
      item.pointer('pointerdown', 300, 300, button); item.pointer('pointermove', 350, 325, button); item.pointer('pointerup', 350, 325, button); item.settle();
      item.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true })); item.settle();
    }
    near(f.pose(), stock.pose());
  });
  it('does not claim a body/gizmo press rejected before OrbitControls starts', () => {
    const resolve = vi.fn(() => new THREE.Vector3()), f = fixture(resolve), before = f.pose();
    const veto = (event: Event) => event.stopImmediatePropagation();
    // R3F's native listener is registered before OrbitControls in the viewport.
    f.controls.dispose(); f.canvas.addEventListener('pointerdown', veto); f.controls.connect(f.canvas);
    f.pointer('pointerdown', 300, 300); f.pointer('pointermove', 350, 325); f.pointer('pointerup', 350, 325); f.settle();
    near(f.pose(), before); expect(resolve).not.toHaveBeenCalled();
  });
  it('drops old inertia without moving the pose or emitting intermediate changes at a tool handoff', () => {
    const f = fixture(); f.pointer('pointerdown', 300, 300); f.pointer('pointermove', 350, 325); f.pointer('pointerup', 350, 325);
    const before = f.pose(), change = vi.fn(); f.controls.addEventListener('change', change);
    f.adapter!.stop(); near(f.pose(), before); expect(change).not.toHaveBeenCalled();
    for (let i = 0; i < 10; ++i) f.controls.update(); near(f.pose(), before);
  });
  it('uses the same pivot for one-finger touch orbit', () => {
    const pivot = new THREE.Vector3(100, 40, 20), f = fixture(() => pivot), before = f.point(pivot), pose = f.pose();
    const options = { pointerType: 'touch' };
    f.pointer('pointerdown', 300, 300, 0, options); f.pointer('pointermove', 350, 325, 0, options); f.pointer('pointerup', 350, 325, 0, options); f.settle();
    expect(f.pose()).not.toEqual(pose); near(f.point(pivot), before);
  });
});
