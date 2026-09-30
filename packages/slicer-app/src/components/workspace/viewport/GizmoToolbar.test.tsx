// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneInteractionController } from './SceneInteractionController';
import type { PaintingPhase } from './gizmo/painting/PaintingController';
import { GizmoToolbar } from './GizmoToolbar';

const mocked = vi.hoisted(() => ({
  phase: 'closed' as PaintingPhase,
  close: vi.fn(), open: vi.fn(),
  runtime: { getRuntimeExecutionState: () => ({ serialSliceActive: false }) },
}));
vi.mock('@orca/platform-contract', () => ({ usePlatform: () => ({ runtime: mocked.runtime }) }));
vi.mock('./gizmo/painting/PaintingProvider', () => ({
  usePaintingState: () => ({ phase: mocked.phase }),
  usePaintingController: () => ({
    get active() { return mocked.phase !== 'closed'; },
    get unfinished() { return ['drawing', 'ending', 'cancelling'].includes(mocked.phase); },
    close: mocked.close, open: mocked.open,
  }),
  paintingTarget: () => ({ objectId: 1, instanceId: 2 }),
}));
vi.mock('../../../stores/useSettingsStore', () => ({ useSettingsStore: () => true }));
vi.mock('../../../stores/useFilamentSessionStore', () => ({ useFilamentSessionStore: () => 2 }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const scene = {
  selection: { subscribe: () => () => {}, revision: 0, empty: false },
  subscribe: () => () => {}, hasWipeTowerSelection: false,
  gizmo: null as SceneInteractionController['gizmo'],
  closeGizmo: vi.fn(() => { scene.gizmo = null; }),
  toggleGizmo: vi.fn((mode: SceneInteractionController['gizmo']) => { scene.gizmo = scene.gizmo === mode ? null : mode; }),
};
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('PointerEvent', MouseEvent);
  mocked.phase = 'closed'; scene.gizmo = null;
  mocked.close.mockImplementation(async () => { mocked.phase = 'closed'; return true; });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<GizmoToolbar sceneInteraction={scene as unknown as SceneInteractionController} />));
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
    expect(mocked.open).toHaveBeenCalledWith(1, 2);
    expect(scene.closeGizmo.mock.invocationCallOrder[0]).toBeLessThan(mocked.open.mock.invocationCallOrder[0]);
    mocked.phase = 'idle'; await render();
    expect(button('rotate').getAttribute('aria-pressed')).toBe('false');
    await act(async () => button('paint').click()); await render();
    expect(mocked.close).toHaveBeenCalledOnce();
    expect(button('paint').getAttribute('aria-pressed')).toBe('false');
  });
});
