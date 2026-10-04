// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_USER_PREFERENCES, normalizeArrangementPreferences, type PlatformCapabilities } from '@orca/platform-contract';
import type { PlateSessionSnapshot } from '@slicer/client';
import { useArrangementStore } from '@/stores/useArrangementStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { useSlicerStore } from '@/stores/useSlicerStore';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { ArrangeCurrentPlateButton, ArrangementButton, ArrangementPanel, ArrangementStatus } from './ArrangementControls';

const mocked = vi.hoisted(() => ({
  platform: null as unknown as PlatformCapabilities,
  unfinished: false, activePainting: false, closePainting: vi.fn(),
  arrange: vi.fn(), cancel: vi.fn(),
}));
vi.mock('@orca/platform-contract', async (original) => ({
  ...await original<typeof import('@orca/platform-contract')>(),
  usePlatform: () => mocked.platform,
}));
vi.mock('../actions/arrangementActions', () => ({ arrangeModels: mocked.arrange, cancelArrangement: mocked.cancel }));
vi.mock('../viewport/gizmo/painting/PaintingProvider', () => ({
  usePaintingController: () => ({ unfinished: mocked.unfinished, active: mocked.activePainting, close: mocked.closePainting }),
  usePaintingState: () => ({ phase: mocked.activePainting ? 'idle' : 'closed' }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const scene = { owner: 'none', subscribe: () => () => {}, closeGizmo: vi.fn() } as unknown as SceneInteractionController;
function ArrangementHarness() {
  const [open, setOpen] = useState(false);
  return <>
    <ArrangementButton sceneInteraction={scene} open={open} onOpenChange={setOpen} />
    {open && <ArrangementPanel sceneInteraction={scene} onClose={() => setOpen(false)} />}
  </>;
}
const button = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
const plateSnapshot = (locked = false): PlateSessionSnapshot => ({
  ok: true, version: 1, currentPlateId: 'one', instances: [],
  plates: [{ plateId: 'one', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1', locked }],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('PointerEvent', MouseEvent);
  mocked.unfinished = false; mocked.activePainting = false; mocked.closePainting.mockResolvedValue(true);
  mocked.platform = {
    preferences: { load: vi.fn(async () => DEFAULT_USER_PREFERENCES), save: vi.fn(async () => {}) },
    runtime: { getRuntimeExecutionState: () => ({ threaded: true, serialSliceActive: false }) },
  } as unknown as PlatformCapabilities;
  useArrangementStore.setState({ preferences: normalizeArrangementPreferences(null), ready: false, active: false,
    alignY: false, mode: 'byLayer', printer: null, printerStructure: '', result: null,
    progress: 0, message: '', cancellable: false, cancelling: false });
  useSettingsStore.setState({ modelLoaded: true, selectedPrinter: 'Printer', printers: [], values: { printer_structure: 'i3' } });
  useSlicerStore.setState({ status: 'idle' });
  usePlateSessionStore.setState({ snapshot: plateSnapshot() });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('arrangement controls', () => {
  it('keeps current-plate arrangement separate and refuses locks, unfinished painting, empty models and serial slicing', async () => {
    const render = () => act(async () => root.render(<ArrangeCurrentPlateButton sceneInteraction={scene} />));
    await render();
    expect(button('arrange-current-plate').disabled).toBe(false);
    await act(async () => button('arrange-current-plate').click());
    expect(mocked.arrange).toHaveBeenCalledWith(mocked.platform, scene, 'current');
    await act(async () => usePlateSessionStore.setState({ snapshot: plateSnapshot(true) }));
    expect(button('arrange-current-plate').disabled).toBe(true);
    await act(async () => usePlateSessionStore.setState({ snapshot: plateSnapshot() }));
    mocked.unfinished = true; await render();
    expect(button('arrange-current-plate').disabled).toBe(true);
    mocked.unfinished = false; await act(async () => useSettingsStore.setState({ modelLoaded: false }));
    expect(button('arrange-current-plate').disabled).toBe(true);
    await act(async () => useSettingsStore.setState({ modelLoaded: true }));
    await act(async () => useSlicerStore.setState({ status: 'slicing' }));
    expect(button('arrange-current-plate').disabled).toBe(false);
    mocked.platform.runtime.getRuntimeExecutionState = () => ({ threaded: false, sliceActive: true, serialSliceActive: true, serialTerminalEpoch: '0' });
    await render();
    expect(button('arrange-current-plate').disabled).toBe(true);
  });

  it('renders real progress, permits threaded cancellation, and has no serial Cancel action', async () => {
    useArrangementStore.setState({ active: true, progress: 42, message: 'Packing plate 2', cancellable: false });
    await act(async () => root.render(<ArrangementStatus />));
    expect(container.textContent).toContain('Packing plate 2');
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42');
    expect(button('arrange-cancel')).toBeNull();
    expect(container.querySelector('[data-arrangement-allowed="true"]')).not.toBeNull();
    await act(async () => useArrangementStore.setState({ cancellable: true }));
    await act(async () => button('arrange-cancel').click());
    expect(mocked.cancel).toHaveBeenCalledWith(mocked.platform);
    await act(async () => useArrangementStore.setState({ cancelling: true }));
    expect(button('arrange-cancel').disabled).toBe(true);
  });

  it('reports each parking reason and the plate limit, and allows dismissing the result', async () => {
    useArrangementStore.setState({ result: { ok: true, cancelled: false, changed: false, placed: 7,
      plateLimitReached: true, unplaced: [
        { instanceId: 1, reason: 'plate-limit' }, { instanceId: 2, reason: 'plate-limit' },
        { instanceId: 3, reason: 'non-printable' }, { instanceId: 4, reason: 'too-tall' },
      ] } });
    await act(async () => root.render(<ArrangementStatus />));
    expect(container.textContent).toContain('7 placed · 4 parked outside plates');
    expect(container.textContent).toContain('The 36-plate limit was reached.');
    expect(container.textContent).toContain('36-plate limit reached: 2');
    expect(container.textContent).toContain('Marked non-printable: 1');
    expect(container.textContent).toContain('Exceeds print height: 1');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss arrangement status"]')!.click());
    expect(container.textContent).toBe('');
  });

  it('opens settings rather than running immediately and applies rotation exclusion in the visible controls', async () => {
    await act(async () => root.render(<ArrangementHarness />));
    await act(async () => button('arrange-menu').click());
    expect(mocked.arrange).not.toHaveBeenCalled();
    expect(button('arrange-all')).not.toBeNull();
    expect(button('arrange-align-y').getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('input[data-testid="arrange-distance"]')?.getAttribute('max')).toBeNull();
    const input = document.querySelector<HTMLInputElement>('input[data-testid="arrange-distance"]')!;
    const enterDistance = (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await enterDistance('-1');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(button('arrange-all').disabled).toBe(true);
    expect(useArrangementStore.getState().preferences.byLayer.distance).toBe(0);
    await enterDistance('250.5');
    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(button('arrange-all').disabled).toBe(false);
    expect(useArrangementStore.getState().preferences.byLayer.distance).toBe(250.5);
    await act(async () => button('arrange-rotate').click());
    expect(button('arrange-align-y').getAttribute('aria-disabled')).toBe('true');
    expect(button('arrange-align-y').getAttribute('aria-checked')).toBe('false');
    await act(async () => button('arrange-reset').click());
    expect(button('arrange-align-y').getAttribute('aria-disabled')).not.toBe('true');
    expect(button('arrange-align-y').getAttribute('aria-checked')).toBe('true');
    await act(async () => button('arrange-all').click());
    expect(mocked.arrange).toHaveBeenCalledWith(mocked.platform, scene, 'all');
    expect(button('arrange-all')).toBeNull();
  });
});

it('closes the transform before opening Arrange and toggles its panel closed', async () => {
  await act(async () => root.render(<ArrangementHarness />));
  await act(async () => button('arrange-menu').click());
  expect(scene.closeGizmo).toHaveBeenCalledOnce();
  expect(button('arrange-all')).not.toBeNull();
  await act(async () => button('arrange-menu').click());
  expect(button('arrange-all')).toBeNull();
});
it('opens Arrange only after a successful painting close', async () => {
  mocked.activePainting = true;
  mocked.closePainting.mockResolvedValueOnce(false);
  await act(async () => root.render(<ArrangementHarness />));
  await act(async () => button('arrange-menu').click());
  expect(button('arrange-all')).toBeNull();
  expect(scene.closeGizmo).not.toHaveBeenCalled();
  await act(async () => button('arrange-menu').click());
  expect(mocked.closePainting).toHaveBeenCalledTimes(2);
  expect(scene.closeGizmo).toHaveBeenCalledOnce();
  expect(button('arrange-all')).not.toBeNull();
});
