// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaintingState } from './PaintingController';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import type { FilamentSessionSnapshot } from '@slicer/client';
import { MmuPaintingPanel } from './MmuPaintingPanel';

const mocked = vi.hoisted(() => ({ state: null as PaintingState | null, controller: { setTool: vi.fn(), setSettings: vi.fn(), close: vi.fn(), apply: vi.fn() } }));
vi.mock('./PaintingProvider', () => ({ usePaintingState: () => mocked.state, usePaintingController: () => mocked.controller }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('PointerEvent', MouseEvent);
  mocked.state = { phase: 'idle', channel: 'mmu', session: null, tool: 'circle', settings: { state: 1, erase: false, vertical: false, radius: 2, height: 1, angle: 30, gapArea: 0, overhangAngle: 0, restrictToOverhangs: false }, error: null, display: null, epoch: 0 };
  useFilamentSessionStore.setState({ snapshot: { slots: Array.from({ length: 18 }, (_, i) => ({ slot: i + 1, preset: { name: 'PLA', label: 'PLA', vendor: '', id: `${i}` }, colour: { effective: '#ff0000', provenance: 'user', native: { representative: '#ff0000', multiColour: '#ff0000', type: '1' }, display: { mode: 'solid', colors: ['#ff0000'] } } })) } as unknown as FilamentSessionSnapshot });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useFilamentSessionStore.getState().reset(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<MmuPaintingPanel />));
describe('surface painting panel', () => {
  it('shows the native gradient in a filament painting choice', async () => {
    const snapshot = useFilamentSessionStore.getState().snapshot!;
    useFilamentSessionStore.setState({ snapshot: { ...snapshot, slots: snapshot.slots.map((slot) => slot.slot === 1
      ? { ...slot, colour: { ...slot.colour, display: { mode: 'gradient' as const, colors: ['#ff0000', '#0000ff'] } } } : slot) } });
    await render();
    const choice = container.querySelector('[aria-label="Painting filament"] label') as HTMLElement;
    expect(choice.title).toContain('Gradient: #ff0000 → #0000ff');
    expect([...choice.querySelectorAll<HTMLElement>('span[style]')].map((span) => span.style.backgroundImage))
      .toContain('linear-gradient(90deg, #ff0000, #0000ff)');
  });
  it('offers all six tools, first sixteen palette entries and the limit explanation', async () => {
    await render();
    expect(container.querySelectorAll('[aria-label="Painting tool"] [role="radio"]')).toHaveLength(6);
    const palette = container.querySelector('[aria-label="Painting filament"]')!;
    expect(palette.querySelectorAll('[role="radio"]')).toHaveLength(16); expect(palette.textContent).toContain('Paint filament 16');
    expect(container.textContent).toContain('supports filaments 1–16');
    await act(async () => (container.querySelector('[data-testid="painting-tool-region"]') as HTMLElement).click());
    expect(mocked.controller.setTool).toHaveBeenCalledWith('region');
  });
  it('locks tools and terminal actions while keeping live color, erase and radius enabled', async () => {
    mocked.state!.phase = 'drawing'; await render();
    expect(container.querySelector('[data-testid="painting-tool-sphere"]')?.getAttribute('aria-disabled')).toBe('true');
    expect(container.querySelector('[aria-label="Painting filament"] [role="radio"]')?.getAttribute('aria-disabled')).not.toBe('true');
    expect((container.querySelector('[aria-label="Radius (mm)"]') as HTMLInputElement).disabled).toBe(false);
    expect(container.querySelector('[role="checkbox"]')?.getAttribute('aria-disabled')).not.toBe('true');
    expect([...container.querySelectorAll('button')].every((b) => b.disabled)).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Processing…');
  });
  it('region defaults expose edge detection and exact angle bounds; gap exposes Apply and native area bounds', async () => {
    mocked.state!.tool = 'region'; await render();
    const angle = container.querySelector<HTMLInputElement>('[aria-label="Edge angle (degrees)"]')!;
    expect([angle.value, angle.min, angle.max]).toEqual(['30', '0', '90']);
    mocked.state!.tool = 'gap'; await render();
    const area = container.querySelector<HTMLInputElement>('[aria-label="Gap area (mm²)"]')!;
    expect([area.min, area.max]).toEqual(['0', '5']);
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Apply gap fill')!.click());
    expect(mocked.controller.apply).toHaveBeenCalledWith('gap');
    expect(container.querySelector('[aria-label="Painting filament"]')).toBeNull();
  });
  it('closed hides panel; errors retain explicit closure retry', async () => {
    mocked.state!.phase = 'closed'; await render(); expect(container.children).toHaveLength(0);
    mocked.state!.phase = 'error'; mocked.state!.error = 'projection failed'; await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('projection failed');
    const close = container.querySelector<HTMLButtonElement>('[aria-label="Close painting"]')!;
    expect(close.disabled).toBe(false); await act(async () => close.click()); expect(mocked.controller.close).toHaveBeenCalledTimes(1);
  });
});
