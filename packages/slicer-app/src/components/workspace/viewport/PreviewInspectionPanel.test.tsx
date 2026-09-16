// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { PreviewInspectionPanel, formatPreviewTime } from './PreviewInspectionPanel';
import type { ToolpathGeometry } from './useSliceResult';

const data: ToolpathGeometry = {
  receipt: { plateId: 'plate-1', inputStamp: 1, resultGeneration: '1', sliceTaskId: '1' },
  segmentCount: 3,
  palette: [{ id: 0, name: 'Perimeter', color: [220, 50, 50] }],
  layerIds: Uint32Array.from([0, 0, 1]),
  moveOrders: Uint32Array.from([0, 1, 0]),
  gcodeIds: Uint32Array.from([11, 12, 30]),
  features: Uint32Array.from([0, 0, 0]),
  moveTypes: Uint8Array.from([8, 10, 10]),
  extruderIds: Uint8Array.from([0, 0, 0]),
  metrics: { feedrate: Float32Array.from([10, 20, 30]) },
  ends: Float32Array.from([1, 2, 0.2, 3, 4, 0.2, 5, 6, 0.4]),
  metadata: {
    resultId: 1,
    layerRanges: [
      { id: 0, z: 0.2, firstSegment: 0, segmentCount: 2 },
      { id: 1, z: 0.4, firstSegment: 2, segmentCount: 1 },
    ],
    featurePalette: [{ id: 0, name: 'Perimeter', color: [220, 50, 50] }],
    sourceLineMapping: { available: true, lineCount: 30 },
    analysis: {
      summary: { estimatedTimeSeconds: 3661, filamentLengthMeters: 1.25, filamentWeightGrams: 3.5, filamentCost: 0.07 },
      featureStatistics: [{ featureId: 0, timeSeconds: 3600, filamentLengthMeters: 1.25 }],
      metricRanges: { feedrate: { min: 10, max: 30 } },
    },
  },
  analysis: {
    summary: { estimatedTimeSeconds: 3661, filamentLengthMeters: 1.25, filamentWeightGrams: 3.5, filamentCost: 0.07 },
    featureStatistics: [{ featureId: 0, timeSeconds: 3600, filamentLengthMeters: 1.25 }],
    metricRanges: { feedrate: { min: 10, max: 30 } },
  },
  dispose: () => undefined,
};

describe('PreviewInspectionPanel', () => {
  let root: Root | undefined;
  afterEach(() => {
    root?.unmount(); root = undefined; document.body.innerHTML = '';
    useSlicerStore.getState().resetPreviewState();
  });

  it('formats standard time without exposing a silent/stealth value', () => {
    expect(formatPreviewTime(3661)).toBe('1h 1m 1s');
    expect(formatPreviewTime(60)).toBe('1m 0s');
    expect(formatPreviewTime(undefined)).toBeUndefined();
  });

  it('renders summary, feature statistics, and the nearest current move', async () => {
    useSlicerStore.getState().setPreviewBounds(1, 1, 1);
    useSlicerStore.getState().setPreviewLayerEnd(0, 1);
    useSlicerStore.getState().setPreviewMoveEnd(1);
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<PreviewInspectionPanel data={data} />); });
    expect(container.querySelector('[data-testid="preview-statistics"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="preview-feature-stat-0"]')?.textContent).toContain('1h 0m 0s');
    expect(container.querySelector('[data-testid="preview-inspection-card"]')?.textContent).toContain('G-code line12');
    expect(container.querySelector('[data-testid="preview-inspection-card"]')?.textContent).toContain('Position3.00 / 4.00 / 0.20 mm');
  });

  it('omits source lines when mapping is unavailable', async () => {
    useSlicerStore.getState().setPreviewBounds(1, 0, 1);
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<PreviewInspectionPanel data={{ ...data, metadata: { ...data.metadata!, sourceLineMapping: { available: false, lineCount: 0 } } }} />); });
    expect(container.querySelector('[data-testid="preview-inspection-card"]')?.textContent).not.toContain('G-code line');
  });
});
