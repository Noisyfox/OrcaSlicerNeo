// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { LayerScrubber } from './LayerScrubber';
import { PREVIEW_SCHEME_LABELS } from './toolpathColors';
import type { ToolpathGeometry } from './useSliceResult';

const data: ToolpathGeometry = {
  segmentCount: 4,
  palette: [{ id: 0, name: 'Perimeter', color: [220, 50, 50] }, { id: 1, name: 'Infill', color: [50, 120, 220] }],
  layerIds: Uint32Array.from([0, 0, 1, 1]), moveOrders: Uint32Array.from([0, 1, 0, 1]),
  features: Uint32Array.from([0, 1, 0, 1]), moveTypes: Uint8Array.from([10, 8, 10, 10]), extruderIds: Uint8Array.from([0, 0, 1, 1]), metrics: { feedrate: Float32Array.from([10, 20, 30, 40]) },
  extruderPalette: [{ id: 0, tool: 0, name: 'Red PLA', color: [255, 0, 0] }, { id: 1, tool: 1, name: 'Blue PLA', color: [0, 0, 255] }],
  analysis: { summary: {}, featureStatistics: [], metricRanges: { feedrate: { min: 10, max: 40 } } },
  ends: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]), dispose: () => undefined,
};

describe('LayerScrubber preview controls', () => {
  let root: Root | undefined;
  afterEach(() => { root?.unmount(); root = undefined; document.body.innerHTML = ''; useSlicerStore.getState().resetPreviewState(); });

  it('exposes feature, travel, dimming, single-layer controls and hide semantics', async () => {
    useSlicerStore.getState().setPreviewBounds(1, 1, 1);
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<LayerScrubber data={data} />); });
    expect(container.querySelector('[data-testid="preview-legend"]')).toBeTruthy();
    await act(async () => { container.querySelector('[data-testid="preview-feature-visibility-1"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(useSlicerStore.getState().preview.schemeVisibility.feature?.[1]).toBe(false);
    await act(async () => { container.querySelector('[data-testid="preview-travel-toggle"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(useSlicerStore.getState().preview.showTravel).toBe(false);
    await act(async () => { container.querySelector('[data-testid="preview-single-layer"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(useSlicerStore.getState().preview.singleLayer).toBe(true);
  });

  it('renders one move-end thumb and changes the end with keyboard input', async () => {
    useSlicerStore.getState().setPreviewBounds(1, 1, 1);
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<LayerScrubber data={data} />); });

    const moveSlider = container.querySelector('[data-testid="preview-move-range"]') as HTMLElement;
    const moveInput = moveSlider.querySelector('input[type="range"]') as HTMLInputElement;
    expect(moveSlider).toBeTruthy();
    expect(moveSlider.querySelectorAll('input[type="range"]')).toHaveLength(1);
    expect(moveSlider.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Active layer move end');
    expect(moveInput.value).toBe('1');

    expect(container.querySelector('[data-testid="layer-scrubber-start"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="layer-scrubber-end"]')).toBeTruthy();

    await act(async () => {
      moveInput.focus();
      moveInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    });
    expect(useSlicerStore.getState().preview.activeMoveEnd).toBe(0);
    expect(moveInput.value).toBe('0');
  });

  it('resets the move end to the newly selected layer bound', async () => {
    useSlicerStore.getState().setPreviewBounds(1, 1, 1);
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<LayerScrubber data={data} />); });
    const moveInput = container.querySelector('[data-testid="preview-move-range"] input[type="range"]') as HTMLInputElement;
    const layerEnd = container.querySelectorAll('[data-testid="preview-layer-range"] input[type="range"]')[1] as HTMLInputElement;
    await act(async () => {
      moveInput.focus();
      moveInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    });
    expect(useSlicerStore.getState().preview.activeMoveEnd).toBe(0);

    await act(async () => {
      layerEnd.focus();
      layerEnd.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    });
    expect(useSlicerStore.getState().preview.visibleLayerEnd).toBe(0);
    expect(useSlicerStore.getState().preview.activeMoveEnd).toBe(1);
    expect(moveInput.value).toBe('1');
  });

  it('keeps both vertical thumbs usable while single-layer inspection is enabled', async () => {
    useSlicerStore.getState().setPreviewBounds(1, 1, 1);
    useSlicerStore.getState().setPreviewLayerRange([0, 1], 1);
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<LayerScrubber data={data} />); });
    await act(async () => { container.querySelector('[data-testid="preview-single-layer"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const layerInputs = container.querySelectorAll('[data-testid="preview-layer-range"] input[type="range"]');
    expect(layerInputs).toHaveLength(2);
    expect(Array.from(layerInputs).map((input) => (input as HTMLInputElement).value)).toEqual(['1', '1']);
    expect(container.querySelectorAll('[data-testid="preview-layer-range"] [data-slot="slider-range"]')).toHaveLength(1);
    expect(Array.from(container.querySelectorAll('[data-testid="preview-layer-range"] [data-slot="slider-thumb"]')))
      .toHaveLength(2);
    expect(Array.from(container.querySelectorAll('[data-testid="preview-layer-range"] [data-slot="slider-thumb"]'))
      .every((thumb) => thumb.className.includes('z-10'))).toBe(true);

    // Either thumb changes the active layer in single-layer mode. The pair
    // stays equal, so the range never reverses or expands unexpectedly.
    await act(async () => {
      (layerInputs[0] as HTMLInputElement).focus();
      layerInputs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    });
    expect(useSlicerStore.getState().preview).toMatchObject({ visibleLayerStart: 0, visibleLayerEnd: 0 });
    await act(async () => {
      const endInput = container.querySelectorAll('[data-testid="preview-layer-range"] input[type="range"]')[1] as HTMLInputElement;
      endInput.focus();
      endInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    });
    expect(useSlicerStore.getState().preview).toMatchObject({ visibleLayerStart: 1, visibleLayerEnd: 1, maxMove: 1, activeMoveEnd: 1 });
  });

  it('moves the horizontal slider one move per wheel step and clamps at its bounds', async () => {
    useSlicerStore.getState().setPreviewBounds(1, 1, 1);
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<LayerScrubber data={data} />); });
    const moveInput = container.querySelector('[data-testid="preview-move-range"] input[type="range"]') as HTMLInputElement;

    const down = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    await act(async () => { moveInput.dispatchEvent(down); });
    expect(useSlicerStore.getState().preview.activeMoveEnd).toBe(0);
    expect(down.defaultPrevented).toBe(true);

    const up = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    await act(async () => { moveInput.dispatchEvent(up); });
    expect(useSlicerStore.getState().preview.activeMoveEnd).toBe(1);
    const atMax = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    await act(async () => { moveInput.dispatchEvent(atMax); });
    expect(useSlicerStore.getState().preview.activeMoveEnd).toBe(1);
    expect(atMax.defaultPrevented).toBe(true);
  });

  it('moves sliders when the wheel is over the surrounding black frames', async () => {
    useSlicerStore.getState().setPreviewBounds(1, 1, 1);
    useSlicerStore.getState().setPreviewLayerRange([0, 0], 1);
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<LayerScrubber data={data} />); });

    const moveFrame = container.querySelector('[data-testid="preview-move-range"]') as HTMLElement;
    const moveWheel = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    await act(async () => { moveFrame.dispatchEvent(moveWheel); });
    expect(useSlicerStore.getState().preview.activeMoveEnd).toBe(0);
    expect(moveWheel.defaultPrevented).toBe(true);

    const layerFrame = container.querySelector('[data-testid="preview-layer-range"]') as HTMLElement;
    const layerWheel = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    await act(async () => { layerFrame.dispatchEvent(layerWheel); });
    expect(useSlicerStore.getState().preview).toMatchObject({ visibleLayerStart: 0, visibleLayerEnd: 1 });
    expect(layerWheel.defaultPrevented).toBe(true);
  });

  it('always moves the vertical end with the wheel, including over the start thumb', async () => {
    useSlicerStore.getState().setPreviewBounds(1, 1, 1);
    useSlicerStore.getState().setPreviewLayerRange([0, 0], 1);
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<LayerScrubber data={data} />); });
    const layerInputs = container.querySelectorAll('[data-testid="preview-layer-range"] input[type="range"]');
    const startInput = layerInputs[0] as HTMLInputElement;
    const endInput = layerInputs[1] as HTMLInputElement;

    const startUp = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    await act(async () => { startInput.dispatchEvent(startUp); });
    expect(useSlicerStore.getState().preview).toMatchObject({ visibleLayerStart: 0, visibleLayerEnd: 1 });
    expect(startUp.defaultPrevented).toBe(true);

    const endDown = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    await act(async () => { endInput.dispatchEvent(endDown); });
    expect(useSlicerStore.getState().preview).toMatchObject({ visibleLayerStart: 0, visibleLayerEnd: 0 });
    expect(endDown.defaultPrevented).toBe(true);
  });

  it('skips layer IDs that have no renderable segments when wheeling', async () => {
    const sparseData: ToolpathGeometry = {
      ...data,
      segmentCount: 3,
      layerIds: Uint32Array.from([0, 0, 2]),
      moveOrders: Uint32Array.from([0, 1, 0]),
      features: Uint32Array.from([0, 1, 0]),
      moveTypes: Uint8Array.from([10, 8, 10]),
      extruderIds: Uint8Array.from([0, 0, 1]),
      metrics: { feedrate: Float32Array.from([10, 20, 30]) },
      ends: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0]),
    };
    useSlicerStore.getState().setPreviewBounds(2, 1, 1);
    useSlicerStore.getState().setPreviewLayerRange([0, 0], 1);
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<LayerScrubber data={sparseData} />); });
    const layerFrame = container.querySelector('[data-testid="preview-layer-range"]') as HTMLElement;

    const up = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    await act(async () => { layerFrame.dispatchEvent(up); });
    expect(useSlicerStore.getState().preview).toMatchObject({ visibleLayerStart: 0, visibleLayerEnd: 2 });
    expect(up.defaultPrevented).toBe(true);

    const atMax = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    await act(async () => { layerFrame.dispatchEvent(atMax); });
    expect(useSlicerStore.getState().preview.visibleLayerEnd).toBe(2);

    const down = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    await act(async () => { layerFrame.dispatchEvent(down); });
    expect(useSlicerStore.getState().preview).toMatchObject({ visibleLayerStart: 0, visibleLayerEnd: 0 });
    const atMin = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    await act(async () => { layerFrame.dispatchEvent(atMin); });
    expect(useSlicerStore.getState().preview.visibleLayerEnd).toBe(0);
  });

  it('keeps the two vertical thumbs coupled when the wheel moves the end in single-layer mode', async () => {
    useSlicerStore.getState().setPreviewBounds(1, 1, 1);
    useSlicerStore.getState().setPreviewLayerEnd(0, 1);
    useSlicerStore.getState().setPreviewSingleLayer(true);
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<LayerScrubber data={data} />); });
    const startInput = container.querySelectorAll('[data-testid="preview-layer-range"] input[type="range"]')[0] as HTMLInputElement;
    const wheelUp = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    await act(async () => { startInput.dispatchEvent(wheelUp); });
    expect(useSlicerStore.getState().preview).toMatchObject({ visibleLayerStart: 1, visibleLayerEnd: 1 });
    expect(wheelUp.defaultPrevented).toBe(true);
  });

  it('keeps legend filters scoped to the selected scheme', async () => {
    useSlicerStore.getState().setPreviewBounds(1, 1, 1);
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<LayerScrubber data={data} />); });
    const scheme = container.querySelector('[data-testid="preview-color-scheme"]') as HTMLButtonElement;
    await act(async () => {
      scheme.click();
    });
    await act(async () => {
      const option = document.body.querySelector('[data-testid="preview-color-scheme-filament"]') as HTMLElement;
      option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      option.click();
    });
    // The trigger shows the scheme label, not the raw value
    expect(container.querySelector('[data-testid="preview-color-scheme"] [data-slot="select-value"]')?.textContent).toBe(PREVIEW_SCHEME_LABELS.filament);
    const filamentEntry = container.querySelector('[data-testid="preview-scheme-visibility-filament-1"]') as HTMLButtonElement;
    await act(async () => { filamentEntry.click(); });
    expect(useSlicerStore.getState().preview.schemeVisibility.filament?.[1]).toBe(false);
    expect(useSlicerStore.getState().preview.schemeVisibility.feature).toBeUndefined();
    await act(async () => {
      scheme.click();
    });
    await act(async () => {
      const option = document.body.querySelector('[data-testid="preview-color-scheme-feature"]') as HTMLElement;
      option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      option.click();
    });
    expect(container.querySelector('[data-testid="preview-feature-visibility-1"]')).toBeTruthy();
  });

  it('collapses and re-expands the entire preview controls panel from the Preview header', async () => {
    useSlicerStore.getState().setPreviewBounds(1, 1, 1);
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<LayerScrubber data={data} />); });

    const header = container.querySelector('[data-testid="preview-controls-header"]') as HTMLButtonElement;
    const content = container.querySelector('#preview-controls-content') as HTMLElement;
    const entry = () => container.querySelector('[data-testid="preview-feature-visibility-1"]');
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(content.hidden).toBe(false);
    expect(container.querySelector('[data-testid="preview-color-scheme"]')).toBeTruthy();
    expect(entry()).toBeTruthy();

    const controls = container.querySelector('[data-testid="preview-controls"]') as HTMLElement;
    expect(controls.className).toContain('overflow-hidden');
    expect(controls.className).not.toContain('overflow-auto');
    expect(header.className).toContain('shrink-0');
    expect(content.className).toContain('overflow-y-auto');
    expect(content.className).toContain('flex-1');
    expect(content.parentElement).toBe(controls);
    expect(header.parentElement).toBe(controls);

    await act(async () => { header.click(); });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(content.hasAttribute('data-closed')).toBe(true);

    await act(async () => { header.click(); });
    expect(header.getAttribute('aria-expanded')).toBe('true');
    const reopenedContent = container.querySelector('#preview-controls-content') as HTMLElement;
    expect(reopenedContent.hasAttribute('data-closed')).toBe(false);
    expect(entry()).toBeTruthy();
  });
});
