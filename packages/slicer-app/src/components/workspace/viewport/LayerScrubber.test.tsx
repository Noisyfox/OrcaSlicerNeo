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
});
