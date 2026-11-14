// @vitest-environment jsdom
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeasureDisplay, MeasureSelection, MeasureStatus } from '@slicer/client';
import type { MeasureController } from './MeasureController';
import { installMeasureInput } from './MeasureInput';
import { hitsMeasureGripper } from './measureHitTest';

const target = { objectId: 1, instanceId: 2, volumeId: 3 };
const point = { type: 'point' as const, point: [0, 0, 0] as const };
const edge = { type: 'edge' as const, start: [-1, 0, 0] as const, end: [1, 0, 0] as const, length: 2, center: null };
const selection: MeasureSelection = { target, kind: 'feature', source: edge, value: edge };
const status: MeasureStatus = { ok: true, version: 1, sessionId: 'ms-1', targetRevision: 1, selectionRevision: 1,
  first: selection, second: null, sameTarget: true, result: null };
const display: MeasureDisplay = { ...status, displayId: 'md-1', hover: null,
  markers: [{ index: 0, position: [0, 1, 0], item: { target, kind: 'midpoint', source: edge, value: point } }] };
const rect = { left: 20, top: 10, width: 600, height: 600 };

describe('Measure gripper gesture preflight', () => {
  it('includes projected off-surface markers and selected edges', () => {
    const camera = new THREE.OrthographicCamera(-3, 3, 3, -3, .1, 100);
    camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    expect(hitsMeasureGripper({ x: 320, y: 210 }, camera, rect, display)).toBe(true);
    expect(hitsMeasureGripper({ x: 370, y: 310 }, camera, rect, display)).toBe(true);
    expect(hitsMeasureGripper({ x: 370, y: 310 }, camera, rect, null, status)).toBe(true);
    expect(hitsMeasureGripper({ x: 550, y: 550 }, camera, rect, display)).toBe(false);
  });

  it('includes an oriented circle without relying on a mesh hit', () => {
    const camera = new THREE.OrthographicCamera(-3, 3, 3, -3, .1, 100);
    camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    const circle = { type: 'circle' as const, center: [0, 0, 0] as const, radius: 1, normal: [0, 0, 1] as const, diameter: 2 };
    const withCircle: MeasureDisplay = { ...display, first: { target, kind: 'feature', source: circle, value: circle }, markers: [] };
    expect(hitsMeasureGripper({ x: 420, y: 310 }, camera, rect, withCircle)).toBe(true);
    expect(hitsMeasureGripper({ x: 320, y: 310 }, camera, rect, withCircle)).toBe(false);
  });
});

let canvas: HTMLCanvasElement, camera: THREE.PerspectiveCamera, dispose: () => void;
let captures: Set<number>, surface: boolean;
const owner = { getSnapshot: vi.fn(), click: vi.fn(), hover: vi.fn(), invalidateHover: vi.fn() };
const controls = { target: new THREE.Vector3(), enableDamping: true, update: vi.fn() };
const invalidate = vi.fn();
function pointer(type: string, init: MouseEventInit = {}): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 320, clientY: 310, ...init });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event as PointerEvent;
}
beforeEach(() => {
  vi.clearAllMocks(); surface = false; captures = new Set();
  canvas = document.createElement('canvas'); document.body.append(canvas);
  canvas.getBoundingClientRect = () => rect as DOMRect;
  Object.defineProperty(canvas, 'clientHeight', { value: 600 });
  canvas.setPointerCapture = id => { captures.add(id); };
  canvas.hasPointerCapture = id => captures.has(id);
  canvas.releasePointerCapture = id => { captures.delete(id); };
  camera = new THREE.PerspectiveCamera(45, 1, .1, 100); camera.up.set(0, 0, 1);
  camera.position.set(0, -10, 10); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  controls.target.set(0, 0, 0); controls.enableDamping = true;
  owner.getSnapshot.mockReturnValue({ display: null }); owner.click.mockReturnValue(true);
  dispose = installMeasureInput({ canvas, camera, controls, controller: owner as unknown as MeasureController,
    hitsSurface: () => surface, pivot: () => new THREE.Vector3(), invalidate });
});
afterEach(() => { dispose(); canvas.remove(); });

it('claims a feature press with the original pointer and camera, including Shift', () => {
  surface = true; const before = camera.position.clone();
  canvas.dispatchEvent(pointer('pointerdown', { shiftKey: true }));
  expect(owner.click).toHaveBeenCalledOnce();
  const captured = owner.click.mock.calls[0][0];
  expect(captured).toMatchObject({ pointer: [320, 310], viewport: [20, 10, 600, 600] });
  expect(owner.click.mock.calls[0][1]).toBe(true);
  canvas.dispatchEvent(pointer('pointermove', { clientX: 500, clientY: 400 }));
  expect(camera.position.equals(before)).toBe(true);
  expect(captured.pointer).toEqual([320, 310]);
  canvas.dispatchEvent(pointer('pointerup', { clientX: 500, clientY: 400 }));
  expect(captures.size).toBe(0); expect(owner.hover).toHaveBeenCalledOnce();
});

it('keeps a blank-start orbit even after moving across a feature', () => {
  const before = camera.position.clone();
  canvas.dispatchEvent(pointer('pointerdown', { clientX: 100, clientY: 100 }));
  surface = true; canvas.dispatchEvent(pointer('pointermove', { clientX: 350, clientY: 350 }));
  expect(camera.position.equals(before)).toBe(false); expect(owner.click).not.toHaveBeenCalled();
  expect(owner.invalidateHover).toHaveBeenCalledOnce();
  canvas.dispatchEvent(pointer('pointerup')); expect(invalidate).toHaveBeenCalled();
});

it.each([{ ctrlKey: true }, { metaKey: true }])('rotates over a model with modifiers %o', modifiers => {
  surface = true; const before = camera.position.clone();
  canvas.dispatchEvent(pointer('pointerdown', modifiers));
  canvas.dispatchEvent(pointer('pointermove', { ...modifiers, clientX: 350 }));
  expect(camera.position.equals(before)).toBe(false); expect(owner.click).not.toHaveBeenCalled();
  canvas.dispatchEvent(pointer('pointerup', modifiers));
});

it.each([1, 2])('pans with button %s, zooms with the wheel, and restores damping', button => {
  surface = true; const before = controls.target.clone();
  canvas.dispatchEvent(pointer('pointerdown', { button }));
  canvas.dispatchEvent(pointer('pointermove', { button, clientX: 350 }));
  expect(controls.target.equals(before)).toBe(false); expect(owner.click).not.toHaveBeenCalled();
  canvas.dispatchEvent(pointer('pointerup', { button }));
  const distance = camera.position.distanceTo(controls.target);
  canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }));
  expect(camera.position.distanceTo(controls.target)).toBeGreaterThan(distance);
  dispose(); expect(controls.enableDamping).toBe(true); dispose = () => {};
});
