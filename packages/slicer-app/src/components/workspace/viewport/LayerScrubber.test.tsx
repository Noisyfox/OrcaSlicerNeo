// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { LayerScrubber } from './LayerScrubber';
import type { ToolpathGeometry } from './useSliceResult';

const data: ToolpathGeometry = {
  chunks: [], layerRanges: [[0, 2], [2, 2]], segmentCount: 4,
  palette: [{ id: 0, name: 'Perimeter', color: [220, 50, 50] }, { id: 1, name: 'Infill', color: [50, 120, 220] }],
  layerIds: Uint32Array.from([0, 0, 1, 1]), moveOrders: Uint32Array.from([0, 1, 0, 1]),
  features: Uint32Array.from([0, 1, 0, 1]), moveTypes: Uint8Array.from([10, 8, 10, 10]),
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
    expect(useSlicerStore.getState().preview.featureVisibility[1]).toBe(false);
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
});
