// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { PaintingState } from './PaintingController';
import type { LoadedObject } from '../../useModelLoader';
import { PaintingGizmoBase, paintingModelBounds, paintingCursorMeshes, rotatePaintingCamera, panPaintingCamera, triangleContourMaterial } from './PaintingGizmoBase';

const mocked = vi.hoisted(() => ({ state: null as PaintingState | null, owner: null as any, three: null as any }));
vi.mock('./PaintingProvider', () => ({ usePaintingState: () => mocked.state, usePaintingController: () => mocked.owner }));
vi.mock('@react-three/fiber', () => ({ useThree: () => mocked.three }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement, canvas: HTMLCanvasElement;
const identity = new THREE.Matrix4().toArray();
let source: LoadedObject, replacement: THREE.BufferGeometry;
beforeEach(() => {
  resolveCursorColor.mockClear();
  vi.stubGlobal('__ORCA_E2E__', false); vi.stubGlobal('PointerEvent', MouseEvent);
  // React DOM hosts the effect under test. It intentionally has no Three
  // reconciler; capture only the expected custom-element/property warnings.
  vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
    if (!/incorrect casing|unrecognized|does not recognize|non-boolean attribute/.test(String(message))) throw new Error(String(message));
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  canvas = document.createElement('canvas'); document.body.append(canvas);
  const captures = new Set<number>();
  canvas.setPointerCapture = (id) => { captures.add(id); };
  canvas.hasPointerCapture = (id) => captures.has(id);
  canvas.releasePointerCapture = vi.fn((id) => { captures.delete(id); });
  const session = { id: 'ps-1', historySessionId: 'hs-1', revision: 1, objectId: 1, instanceId: 2, instanceTransform: identity, phase: 'idle' as const, strokeId: null, annotation: 'mmu' as const, parts: [{ volumeId: 3, volumeTransform: identity, sourceTriangleCount: 1, draftResourceId: 'a', facetCounts: [] }] };
  mocked.state = { phase: 'idle', session, tool: 'triangle', settings: { state: 1, erase: false, radius: 2, height: 1, angle: 30, gapArea: 0 }, error: null, epoch: 1,
    display: { ok: true, version: 1, sessionId: session.id, revision: 1, session, palette: null, parts: [{ volumeId: 3, resourceId: 'a' }], candidates: [], resources: [{ resourceId: 'a', volumeId: 3, kind: 'draft', vertices: new Float32Array(18), groups: [[0, 0, 3]], contour: new Float32Array() }] } };
  mocked.owner = { getSnapshot: () => mocked.state, get unfinished() { return mocked.state?.phase === 'drawing'; },
    press: vi.fn(async () => { mocked.state = { ...mocked.state!, phase: 'drawing' }; return 'paint'; }),
    release: vi.fn(), hoverAt: vi.fn(), reportDisplayError: vi.fn(), move: vi.fn(), cancel: vi.fn(), close: vi.fn() };
  const camera = new THREE.PerspectiveCamera(); camera.up.set(0, 0, 1); camera.position.set(80, -90, 100);
  const target = new THREE.Vector3(20, 30, 0); camera.lookAt(target); camera.updateMatrixWorld();
  mocked.three = { camera, gl: { domElement: canvas }, invalidate: vi.fn(), controls: { target, enableDamping: true, update: vi.fn(() => { camera.lookAt(target); camera.updateMatrixWorld(); }) } };
  Object.defineProperty(canvas, 'clientHeight', { value: 600 });
  source = { geometry: new THREE.BoxGeometry(), buffer: { objectId: 1, instanceId: 2, volumeId: 3 } } as unknown as LoadedObject;
  replacement = new THREE.BoxGeometry(2, 2, 2);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); canvas.remove(); source.geometry.dispose(); replacement.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const resolveCursorColor = vi.fn(() => new THREE.Color('#abcdef'));
const render = (volumes: LoadedObject[]) => act(async () => root.render(<PaintingGizmoBase volumes={volumes} resolveColor={() => '#abcdef'} resolveCursorColor={resolveCursorColor} openingVisual={<span>Prepare</span>} />));
it('matches Orca triangle contour depth offset without changing face materials', () => {
  const material = triangleContourMaterial();
  expect(material.color.getHexString()).toBe('ffffff');
  expect(material.depthTest).toBe(true); expect(material.depthWrite).toBe(false);
  const shader = { vertexShader: THREE.ShaderLib.basic.vertexShader } as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  expect(shader.vertexShader).toContain('#include <project_vertex>\n gl_Position.z -= 0.00001 * abs(gl_Position.w);');
  expect(material.customProgramCacheKey()).toBe('painting-triangle-contour');
  material.dispose();
});
function pointer(type: string, options: MouseEventInit = {}) { const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: 10, clientY: 10, ...options }); Object.defineProperty(event, 'pointerId', { value: 1 }); return event; }

it('resolves cursor colour from the retained matched display and current selected state throughout press/ending/erase', async () => {
  mocked.state = { ...mocked.state!, tool: 'circle' };
  vi.spyOn(THREE.Raycaster.prototype, 'intersectObjects').mockReturnValue([{ point: new THREE.Vector3(1, 2, 3) } as THREE.Intersection]);
  await render([source]);
  await act(async () => canvas.dispatchEvent(pointer('pointermove')));
  const previous = mocked.state!.display!;
  expect(resolveCursorColor).toHaveBeenLastCalledWith(previous, 1);
  mocked.state = { ...mocked.state!, display: null, session: { ...mocked.state!.session!, revision: 2 }, settings: { ...mocked.state!.settings, state: 2 } };
  await render([source]); expect(resolveCursorColor).toHaveBeenLastCalledWith(previous, 2);
  for (const phase of ['drawing', 'ending'] as const) {
    mocked.state = { ...mocked.state!, phase, settings: { ...mocked.state!.settings, erase: true } };
    await render([source]); expect(resolveCursorColor).toHaveBeenLastCalledWith(previous, 2);
  }
  const next = { ...previous, session: mocked.state!.session!, revision: 2, resources: [] };
  mocked.state = { ...mocked.state!, phase: 'idle', display: next };
  await render([source]); expect(resolveCursorColor).toHaveBeenLastCalledWith(next, 2);
});

it('keeps a held native gesture when borrowed cursor geometry refreshes, and delivers only the actual pointer terminal', async () => {
  await render([source]);
  await act(async () => canvas.dispatchEvent(pointer('pointerdown')));
  expect(mocked.owner.press).toHaveBeenCalledTimes(1); expect(canvas.hasPointerCapture(1)).toBe(true);
  await render([{ ...source, geometry: replacement } as LoadedObject]);
  expect(mocked.owner.release).not.toHaveBeenCalled(); expect(canvas.releasePointerCapture).not.toHaveBeenCalled();
  await act(async () => canvas.dispatchEvent(pointer('pointerup')));
  expect(mocked.owner.release).toHaveBeenCalledTimes(1); expect(canvas.hasPointerCapture(1)).toBe(false);
});


it.each(['blur', 'pointercancel', 'lostpointercapture', 'unmount'])('retains the reliable terminal for a real %s interruption', async (kind) => {
  await render([source]); await act(async () => canvas.dispatchEvent(pointer('pointerdown')));
  await act(async () => {
    if (kind === 'unmount') root.render(null);
    else if (kind === 'blur') window.dispatchEvent(new Event('blur'));
    else canvas.dispatchEvent(pointer(kind));
  });
  expect(mocked.owner.release).toHaveBeenCalledExactlyOnceWith(); expect(canvas.hasPointerCapture(1)).toBe(false);
});

const pose = () => [...mocked.three.camera.position.toArray(), ...mocked.three.camera.quaternion.toArray(), ...mocked.three.controls.target.toArray()];
const cameraPoint = (point: THREE.Vector3) => { mocked.three.camera.updateMatrixWorld(); return point.clone().applyMatrix4(mocked.three.camera.matrixWorldInverse); };
const near = (actual: readonly number[], expected: readonly number[]) => actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 8));
async function rotate(dx = 30, dy = 20) {
  await act(async () => canvas.dispatchEvent(pointer('pointerdown', { ctrlKey: true })));
  await act(async () => canvas.dispatchEvent(pointer('pointermove', { ctrlKey: true, clientX: 10 + dx, clientY: 10 + dy })));
  await act(async () => canvas.dispatchEvent(pointer('pointerup')));
}

it('uses tight transformed original solid-part bounds for the displayed instance, including Z and excluding other instances', () => {
  const first = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-2, 0, 1, 4, 1, 3, 0, 3, -1], 3));
  const second = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 2, 0, 0, 0, 1, 2], 3));
  const instance = new THREE.Matrix4().makeTranslation(70, -40, 15).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  const session = { ...mocked.state!.session!, instanceTransform: instance.toArray(), parts: [
    { ...mocked.state!.session!.parts[0], volumeTransform: new THREE.Matrix4().makeScale(-2, 3, 4).toArray() },
    { ...mocked.state!.session!.parts[0], volumeId: 4, volumeTransform: new THREE.Matrix4().makeTranslation(10, -5, 8).multiply(new THREE.Matrix4().makeScale(1, 2, -1)).toArray() },
  ] };
  const material = new THREE.MeshBasicMaterial();
  const volumes = [{ ...source, geometry: first }, { ...source, geometry: second, buffer: { ...source.buffer, volumeId: 4 } },
    { ...source, buffer: { ...source.buffer, instanceId: 99 } }, { ...source, buffer: { ...source.buffer, volumeId: 5 } }] as LoadedObject[];
  const meshes = paintingCursorMeshes([], volumes, session, material);
  const box = paintingModelBounds(meshes);
  expect(meshes).toHaveLength(2); near(box.min.toArray(), [61, -48, 11]); near(box.max.toArray(), [75, -28, 27]);
  near(box.getCenter(new THREE.Vector3()).toArray(), [68, -38, 19]);
  expect(paintingModelBounds([]).isEmpty()).toBe(true);
  first.dispose(); second.dispose(); material.dispose();
});

it('rotates camera pose and navigation target rigidly about the model after pan, preserving its camera-space and projected position', () => {
  const camera = mocked.three.camera as THREE.PerspectiveCamera, target = mocked.three.controls.target as THREE.Vector3;
  const pivot = new THREE.Vector3(100, 40, 20);
  panPaintingCamera(camera, target, 170, -110, 600); camera.updateMatrixWorld();
  const before = cameraPoint(pivot), projected = pivot.clone().project(camera), distance = camera.position.distanceTo(pivot), navigationDistance = camera.position.distanceTo(target);
  const targetCamera = cameraPoint(target); const oldPosition = camera.position.clone(), oldQuaternion = camera.quaternion.clone();
  rotatePaintingCamera(camera, target, pivot, 40, 25, 600); camera.updateMatrixWorld();
  expect(camera.position.equals(oldPosition)).toBe(false); expect(camera.quaternion.equals(oldQuaternion)).toBe(false);
  near(cameraPoint(pivot).toArray(), before.toArray()); near(pivot.clone().project(camera).toArray(), projected.toArray());
  near(cameraPoint(target).toArray(), targetCamera.toArray()); expect(camera.position.distanceTo(pivot)).toBeCloseTo(distance, 8);
  expect(camera.position.distanceTo(target)).toBeCloseTo(navigationDistance, 8);
  const rotated = pose(); mocked.three.controls.update(); near(pose(), rotated);
});

it.each([2000, -2000])('keeps the existing safe polar view range after pan with a %s-pixel vertical orbit and closes coherently', (dy) => {
  const camera = mocked.three.camera as THREE.PerspectiveCamera, target = mocked.three.controls.target as THREE.Vector3, pivot = new THREE.Vector3(100, 40, 20);
  panPaintingCamera(camera, target, 200, -100, 600); camera.updateMatrixWorld();
  const before = cameraPoint(pivot);
  rotatePaintingCamera(camera, target, pivot, 45, dy, 600); camera.updateMatrixWorld();
  near(cameraPoint(pivot).toArray(), before.toArray());
  const polar = Math.acos(THREE.MathUtils.clamp(new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion).z, -1, 1));
  expect(polar).toBeGreaterThan(0); expect(polar).toBeLessThan(Math.PI);
  expect(polar).toBeCloseTo(dy > 0 ? 1e-6 : Math.PI - 1e-6, 8);
  const rotated = pose(); mocked.three.controls.update(); near(pose(), rotated);
});

it('opens without reframing, holds the displayed pivot during delayed transform handoff, and uses the new pivot only after publication', async () => {
  const beforeOpen = pose();
  mocked.state = { ...mocked.state!, display: null };
  await render([source]); near(pose(), beforeOpen); await rotate(); near(pose(), beforeOpen);
  const oldSession = { ...mocked.state!.session!, instanceTransform: new THREE.Matrix4().makeTranslation(100, 40, 20).toArray() };
  const display = { ok: true as const, version: 1 as const, sessionId: oldSession.id, revision: 1, session: oldSession, palette: null,
    parts: [{ volumeId: 3, resourceId: 'a' }], candidates: [], resources: [{ resourceId: 'a', volumeId: 3, kind: 'draft' as const, vertices: new Float32Array(18), groups: [[0, 0, 3]] as [number, number, number][], contour: new Float32Array() }] };
  mocked.state = { ...mocked.state!, session: oldSession, display }; await render([source]); near(pose(), beforeOpen);
  const oldPivot = new THREE.Vector3(100, 40, 20), oldPoint = cameraPoint(oldPivot);
  const nextSession = { ...oldSession, instanceTransform: new THREE.Matrix4().makeTranslation(-50, 75, 35).toArray(), revision: 2 };
  mocked.state = { ...mocked.state!, session: nextSession }; await render([source]);
  await rotate(); near(cameraPoint(oldPivot).toArray(), oldPoint.toArray());
  const beforeHandoff = pose(); mocked.state = { ...mocked.state!, display: { ...display, revision: 2, session: nextSession, resources: [] } };
  await render([source]); near(pose(), beforeHandoff);
  const nextPivot = new THREE.Vector3(-50, 75, 35), nextPoint = cameraPoint(nextPivot); await rotate(); near(cameraPoint(nextPivot).toArray(), nextPoint.toArray());
  const otherSource = { ...source, buffer: { ...source.buffer, objectId: 7, instanceId: 8 } } as LoadedObject;
  const otherSession = { ...nextSession, objectId: 7, instanceId: 8, revision: 3, instanceTransform: new THREE.Matrix4().makeTranslation(160, -20, 45).toArray(),
    parts: [{ ...nextSession.parts[0], draftResourceId: 'other' }] };
  mocked.state = { ...mocked.state!, session: otherSession }; await render([source, otherSource]);
  const retainedPoint = cameraPoint(nextPivot); await rotate(); near(cameraPoint(nextPivot).toArray(), retainedPoint.toArray());
  const beforeTargetHandoff = pose();
  mocked.state = { ...mocked.state!, display: { ...display, session: otherSession, revision: 3, parts: [{ volumeId: 3, resourceId: 'other' }],
    resources: [{ ...display.resources[0], resourceId: 'other' }] } };
  await render([source, otherSource]); near(pose(), beforeTargetHandoff);
  const otherPivot = new THREE.Vector3(160, -20, 45), otherPoint = cameraPoint(otherPivot); await rotate(); near(cameraPoint(otherPivot).toArray(), otherPoint.toArray());
  expect(mocked.owner.release).not.toHaveBeenCalled();
  const beforeClose = pose(); await act(async () => root.render(null)); near(pose(), beforeClose);
});

it('retains pivot and cached bounds across RGB/stroke refreshes and prevents camera movement throughout an unfinished stroke', async () => {
  const session = { ...mocked.state!.session!, instanceTransform: new THREE.Matrix4().makeTranslation(100, 40, 20).toArray() };
  mocked.state = { ...mocked.state!, session, display: { ...mocked.state!.display!, session } };
  const attribute = source.geometry.getAttribute('position'), scan = vi.spyOn(attribute, 'getX');
  await render([source]); const scanned = scan.mock.calls.length; expect(scanned).toBe(attribute.count);
  const pivot = new THREE.Vector3(100, 40, 20), before = cameraPoint(pivot);
  mocked.state = { ...mocked.state!, display: { ...mocked.state!.display!, session: { ...session, revision: 2 }, revision: 2, resources: [] } };
  await render([source]); expect(scan).toHaveBeenCalledTimes(scanned);
  await rotate(); near(cameraPoint(pivot).toArray(), before.toArray());
  await act(async () => canvas.dispatchEvent(pointer('pointerdown')));
  const drawing = pose();
  await render([{ ...source, geometry: replacement } as LoadedObject]);
  await act(async () => {
    canvas.dispatchEvent(pointer('pointermove', { ctrlKey: true, clientX: 30, clientY: 25 }));
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
    canvas.dispatchEvent(pointer('pointerdown', { button: 2 }));
  });
  near(pose(), drawing); expect(mocked.owner.release).not.toHaveBeenCalled();
  await act(async () => canvas.dispatchEvent(pointer('pointerup'))); expect(mocked.owner.release).toHaveBeenCalledTimes(1);
});
