// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneInteractionController } from './SceneInteractionController';
import type { PaintingPhase } from './gizmo/painting/PaintingController';
import { GizmoToolbar } from './GizmoToolbar';

const mocked = vi.hoisted(() => ({
  phase: 'closed' as PaintingPhase, channel: 'mmu' as 'mmu' | 'seam' | 'fuzzy' | 'support', slotCount: 2,
  close: vi.fn(), open: vi.fn(), measureActive: false, serialBusy: false, closeMeasure: vi.fn(),
  runtime: { getRuntimeExecutionState: () => ({ serialSliceActive: mocked.serialBusy }) },
}));
vi.mock('@orca/platform-contract', async (importOriginal) => ({ ...await importOriginal<typeof import('@orca/platform-contract')>(), usePlatform: () => ({ runtime: mocked.runtime }) }));
vi.mock('../arrangement/ArrangementControls', () => ({ ArrangementButton: () => null }));
vi.mock('./gizmo/painting/PaintingProvider', () => ({
  usePaintingState: () => ({ phase: mocked.phase, channel: mocked.channel }),
  usePaintingController: () => ({
    get active() { return mocked.phase !== 'closed'; },
    get unfinished() { return ['drawing', 'ending', 'cancelling'].includes(mocked.phase); },
    close: mocked.close, open: mocked.open,
  }),
  paintingTarget: () => ({ objectId: 1, instanceId: 2 }),
}));
vi.mock('./gizmo/measure/projectCommands', () => ({
  measureSessionActive: () => mocked.measureActive,
  closeMeasureForCommand: mocked.closeMeasure,
}));
vi.mock('@/stores/useSettingsStore', () => ({ useSettingsStore: () => true }));
vi.mock('@/stores/useFilamentSessionStore', () => ({ useFilamentSessionStore: () => mocked.slotCount }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const scene = {
  selection: { subscribe: () => () => {}, revision: 0, empty: false },
  subscribe: () => () => {}, hasWipeTowerSelection: false, selectedVolumes: () => [],
  gizmo: null as SceneInteractionController['gizmo'],
  closeGizmo: vi.fn(() => { scene.gizmo = null; }),
  toggleGizmo: vi.fn((mode: SceneInteractionController['gizmo']) => { scene.gizmo = scene.gizmo === mode ? null : mode; }),
};
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('PointerEvent', MouseEvent);
  mocked.phase = 'closed'; mocked.channel = 'mmu'; mocked.slotCount = 2; mocked.measureActive = false; mocked.serialBusy = false; scene.gizmo = null;
  mocked.close.mockImplementation(async () => { mocked.phase = 'closed'; return true; });
  mocked.closeMeasure.mockResolvedValue(undefined);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});

it('toggles Measure and refuses a new serial-slice session while allowing it to close', async () => {
  await render(); expect(button('measure').disabled).toBe(false);
  await act(async () => button('measure').click()); await render();
  expect(button('measure').getAttribute('aria-pressed')).toBe('true');
  mocked.serialBusy = true; await render(); expect(button('measure').disabled).toBe(false);
  await act(async () => button('measure').click()); await render();
  expect(button('measure').disabled).toBe(true);
});

it('waits for Measure cleanup before painting and abandons an obsolete tool switch', async () => {
  let finish!: () => void;
  mocked.closeMeasure.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  mocked.measureActive = true; scene.gizmo = 'measure'; await render();
  await act(async () => button('paint').click());
  expect(scene.closeGizmo).toHaveBeenCalledOnce();
  expect(mocked.closeMeasure).toHaveBeenCalledOnce(); expect(mocked.open).not.toHaveBeenCalled();
  scene.gizmo = 'move';
  await act(async () => { finish(); await Promise.resolve(); });
  expect(mocked.open).not.toHaveBeenCalled();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const arrangementChange = vi.fn();
const render = () => act(async () => root.render(<GizmoToolbar sceneInteraction={scene as unknown as SceneInteractionController} arrangementOpen={false} onArrangementOpenChange={arrangementChange} />));
const button = (name: string) => container.querySelector<HTMLButtonElement>(`[data-testid="gizmo-btn-${name}"]`)!;

describe('gizmo toolbar session state', () => {
  it.each<PaintingPhase>(['closed', 'opening', 'idle', 'drawing', 'ending', 'cancelling', 'closing', 'error'])(
    'keeps painting pressed through %s and preserves idle-only toggles', async (phase) => {
      mocked.phase = phase; await render();
      expect(button('paint').getAttribute('aria-pressed')).toBe(String(phase !== 'closed'));
      const disabled = phase !== 'closed' && phase !== 'idle';
      expect(button('paint').disabled).toBe(disabled);
      for (const mode of ['move', 'rotate', 'scale']) {
        expect(button(mode).getAttribute('aria-pressed')).toBe('false');
        expect(button(mode).disabled).toBe(disabled);
      }
    },
  );
  it('retains painting ownership on failed closure and arms a transform only after successful closure', async () => {
    mocked.phase = 'idle'; mocked.close.mockResolvedValueOnce(false); await render();
    await act(async () => button('move').click()); await render();
    expect(scene.toggleGizmo).not.toHaveBeenCalled();
    expect(button('paint').getAttribute('aria-pressed')).toBe('true');
    await act(async () => button('move').click()); await render();
    expect(button('paint').getAttribute('aria-pressed')).toBe('false');
    expect(button('move').getAttribute('aria-pressed')).toBe('true');
  });
  it('closes an armed transform before opening paint and toggles idle paint closed', async () => {
    scene.gizmo = 'rotate'; await render();
    await act(async () => button('paint').click());
    expect(scene.closeGizmo).toHaveBeenCalledOnce();
    expect(mocked.open).toHaveBeenCalledWith(1, 2, 'mmu');
    expect(scene.closeGizmo.mock.invocationCallOrder[0]).toBeLessThan(mocked.open.mock.invocationCallOrder[0]);
    mocked.phase = 'idle'; await render();
    expect(button('rotate').getAttribute('aria-pressed')).toBe('false');
    await act(async () => button('paint').click()); await render();
    expect(mocked.close).toHaveBeenCalledOnce();
    expect(button('paint').getAttribute('aria-pressed')).toBe('false');
  });
});

it('exposes independent seam entry with one filament and independent support entry', async () => {
  mocked.slotCount = 1; await render();
  expect(button('paint').disabled).toBe(true); expect(button('seam').disabled).toBe(false);
  expect(button('support').disabled).toBe(false);
  await act(async()=>button('support').click()); expect(mocked.open).toHaveBeenCalledWith(1,2,'support');
  expect(button('fuzzy').disabled).toBe(false);
  await act(async()=>button('seam').click()); expect(mocked.open).toHaveBeenCalledWith(1,2,'seam');
  mocked.phase = 'idle'; mocked.channel = 'seam'; await render();
  expect(button('seam').getAttribute('aria-pressed')).toBe('true'); expect(button('paint').getAttribute('aria-pressed')).toBe('false');
  await act(async()=>button('seam').click()); expect(mocked.close).toHaveBeenCalledOnce();
});
it('uses the distinct entries to switch an idle channel and ignores busy clicks', async () => {
  mocked.phase = 'idle'; await render(); await act(async()=>button('seam').click());
  expect(mocked.open).toHaveBeenCalledWith(1,2,'seam'); expect(mocked.close).not.toHaveBeenCalled();
  mocked.channel = 'seam'; await render(); await act(async()=>button('paint').click());
  expect(mocked.open).toHaveBeenLastCalledWith(1,2,'mmu');
  mocked.phase = 'drawing'; await render(); expect(button('paint').disabled).toBe(true); expect(button('seam').disabled).toBe(true);
  const admitted = mocked.open.mock.calls.length; await act(async()=>button('paint').click()); expect(mocked.open).toHaveBeenCalledTimes(admitted);
});

it('orders independent support/seam/fuzzy/MMU entries and routes Fuzzy with one filament',async()=>{
  mocked.slotCount=1;await render();
  const ids=[...container.querySelectorAll('[data-testid^="gizmo-btn-"]')].map(node=>node.getAttribute('data-testid'));
  expect(ids.slice(-4)).toEqual(['gizmo-btn-support','gizmo-btn-seam','gizmo-btn-fuzzy','gizmo-btn-paint']);
  await act(async()=>button('fuzzy').click());expect(mocked.open).toHaveBeenCalledWith(1,2,'fuzzy');
  mocked.phase='idle';mocked.channel='fuzzy';await render();expect(button('fuzzy').getAttribute('aria-pressed')).toBe('true');expect(button('paint').getAttribute('aria-pressed')).toBe('false');expect(button('paint').disabled).toBe(true);
  await act(async()=>button('fuzzy').click());expect(mocked.close).toHaveBeenCalledOnce();
});

it.each(['move', 'rotate', 'scale', 'support', 'seam', 'fuzzy', 'paint'])('closes Arrange when choosing %s', async (tool) => {
  await render(); arrangementChange.mockClear();
  await act(async () => button(tool).click());
  expect(arrangementChange).toHaveBeenCalledWith(false);
});
