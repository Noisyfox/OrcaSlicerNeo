// @vitest-environment jsdom
import { act, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { PlateSessionSnapshot, ProfileSnapshot } from '@slicer/client';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { getPrintableAreaBounds, normalizePrintableArea } from './BedPlate';
import { CameraFraming } from './CameraFraming';

const mocked = vi.hoisted(() => ({ three: null as any }));
vi.mock('@react-three/fiber', () => ({ useThree: (selector: (state: any) => unknown) => selector(mocked.three) }));

let root: Root;
let container: HTMLDivElement;
const originalSettings = useSettingsStore.getState();

function profile(printer = 'Printer A', process = 'Standard', size = 220): ProfileSnapshot {
  return {
    ok: true, printers: [], prints: [], filamentCatalog: [],
    modifiedPresets: { printer: [], filament: [] },
    printerPicker: { items: [], selectedId: '', variants: [], nozzleDiameters: [0.4], selectedVariant: '' },
    printer: { name: printer, idx: 0 }, print: { name: process, idx: 0 },
    bedType: { supportsSelection: false, defaultValue: 'High Temp Plate', choices: [] },
    printable_area: [[0, 0], [size, 0], [size, size], [0, size]],
  };
}

function session(origin: [number, number, number] = [300, -300, 0]): PlateSessionSnapshot {
  return {
    ok: true, version: 1, currentPlateId: 'plate-2',
    plates: [
      { plateId: 'plate-1', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1' },
      { plateId: 'plate-2', displayIndex: 1, origin, name: 'Plate 2' },
    ],
    instances: [], instanceTransforms: [], inputRevisions: { 'plate-1': 0, 'plate-2': 0 },
  };
}

function ViewportFraming(props: Omit<Parameters<typeof CameraFraming>[0], 'bounds'>) {
  const area = useSettingsStore((state) => state.printableArea);
  const bounds = useMemo(() => getPrintableAreaBounds(normalizePrintableArea(area)), [area]);
  return <CameraFraming {...props} bounds={bounds} />;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const camera = new THREE.PerspectiveCamera();
  camera.up.set(0, 0, 1);
  mocked.three = { camera, controls: { target: new THREE.Vector3(), update: vi.fn() } };
  useSettingsStore.getState().hydrateProfileSnapshot(profile());
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useSettingsStore.setState(originalSettings, true);
  vi.unstubAllGlobals();
});

const render = (plateSession = session(), mode: 'prepare' | 'preview' = 'prepare', token?: number) => act(async () => {
  root.render(<ViewportFraming plateSession={plateSession} mode={mode}
    previewFrameRequest={token === undefined ? null : { plateId: 'plate-2', token }} />);
});
const pose = () => ({
  position: mocked.three.camera.position.toArray(),
  direction: mocked.three.camera.quaternion.toArray(),
  zoom: mocked.three.camera.zoom,
  target: mocked.three.controls.target.toArray(),
});
const navigate = () => {
  mocked.three.controls.target.set(400, -175, 25);
  mocked.three.camera.position.set(650, -600, 300);
  mocked.three.camera.lookAt(mocked.three.controls.target);
  mocked.three.camera.zoom = 1.5;
};

it.each(['printer', 'process'] as const)('preserves a navigated camera across a %s snapshot with identical bed bounds', async (kind) => {
  await render();
  navigate();
  const before = pose();
  await act(async () => useSettingsStore.getState().hydrateProfileSnapshot(
    kind === 'printer' ? profile('Printer B') : profile('Printer A', 'Fine'),
  ));
  await render(session()); // Shared-configuration publication also replaces the plate snapshot.
  expect(pose()).toEqual(before);
});

it('frames changed bed dimensions around the current plate including its new origin', async () => {
  await render();
  navigate();
  await act(async () => {
    useSettingsStore.getState().hydrateProfileSnapshot(profile('Printer B', 'Standard', 256));
    root.render(<ViewportFraming plateSession={session([350, -350, 10])} mode="prepare" />);
  });
  expect(mocked.three.controls.target.toArray()).toEqual([478, -222, 10]);
  expect(mocked.three.camera.position.x).toBe(478);
  expect(mocked.three.camera.position.z - 10).toBeCloseTo(-222 - mocked.three.camera.position.y);
  expect(mocked.three.camera.position.distanceTo(mocked.three.controls.target)).toBeCloseTo(256 * 450 / 220);
});

it('retains navigation through mode and plate publications while honoring each explicit Preview frame request once', async () => {
  await render();
  navigate();
  const before = pose();
  await render(session(), 'preview');
  expect(pose()).toEqual(before);
  await render(session(), 'preview', 1);
  expect(mocked.three.controls.target.toArray()).toEqual([410, -190, 0]);
  navigate();
  const afterNavigation = pose();
  await act(async () => useSettingsStore.getState().hydrateProfileSnapshot(profile('Printer A', 'Fine')));
  await render(session(), 'preview', 1);
  expect(pose()).toEqual(afterNavigation);
  await render(session(), 'preview', 2);
  expect(mocked.three.controls.target.toArray()).toEqual([410, -190, 0]);
});
