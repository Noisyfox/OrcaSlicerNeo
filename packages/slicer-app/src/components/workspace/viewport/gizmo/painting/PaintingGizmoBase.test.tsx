// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { PaintingState } from './PaintingController';
import type { LoadedObject } from '../../useModelLoader';
import { PaintingGizmoBase } from './PaintingGizmoBase';

const mocked = vi.hoisted(() => ({ state: null as PaintingState | null, owner: null as any, three: null as any }));
vi.mock('./PaintingProvider', () => ({ usePaintingState: () => mocked.state, usePaintingController: () => mocked.owner }));
vi.mock('@react-three/fiber', () => ({ useThree: () => mocked.three }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement, canvas: HTMLCanvasElement;
const identity = new THREE.Matrix4().toArray();
let source: LoadedObject, replacement: THREE.BufferGeometry;
beforeEach(() => {
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
  mocked.three = { camera: new THREE.PerspectiveCamera(), gl: { domElement: canvas }, invalidate: vi.fn(), controls: null };
  source = { geometry: new THREE.BoxGeometry(), buffer: { objectId: 1, instanceId: 2, volumeId: 3 } } as unknown as LoadedObject;
  replacement = new THREE.BoxGeometry(2, 2, 2);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); canvas.remove(); source.geometry.dispose(); replacement.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const render = (volumes: LoadedObject[]) => act(async () => root.render(<PaintingGizmoBase volumes={volumes} resolveColor={() => '#abcdef'} openingVisual={<span>Prepare</span>} />));
function pointer(type: string) { const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: 10, clientY: 10 }); Object.defineProperty(event, 'pointerId', { value: 1 }); return event; }

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
