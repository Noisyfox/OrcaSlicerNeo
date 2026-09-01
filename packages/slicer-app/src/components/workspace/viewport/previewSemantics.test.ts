// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildPreviewVisibility, lastMovePosition, maxMoveOrderForLayer, previewViewportOwnsKeyboardFocus, TRAVEL_MOVE_TYPE } from './previewSemantics';
import type { ToolpathGeometry } from './useSliceResult';

const data = {
  segmentCount: 6,
  layerIds: Uint32Array.from([0, 0, 1, 1, 1, 2]),
  moveOrders: Uint32Array.from([0, 1, 0, 1, 2, 0]),
  moveTypes: Uint8Array.from([10, TRAVEL_MOVE_TYPE, 10, 10, TRAVEL_MOVE_TYPE, 10]),
  features: Uint32Array.from([0, 1, 0, 1, 0, 1]),
  ends: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0, 5, 0, 0]),
} satisfies Pick<ToolpathGeometry, 'segmentCount' | 'layerIds' | 'moveOrders' | 'moveTypes' | 'features' | 'ends'>;

describe('preview inspection semantics', () => {
  it('uses inclusive layer and active-layer move ranges', () => {
    expect(buildPreviewVisibility(data, {
      visibleLayerStart: 0, visibleLayerEnd: 1,
      activeMoveStart: 1, activeMoveEnd: 1,
      showTravel: true, dimPreviousLayers: true,
    })).toMatchObject({ visible: Uint8Array.from([1, 1, 0, 1, 0, 0]), dimmed: Uint8Array.from([1, 1, 0, 0, 0, 0]) });
  });

  it('hides travel and disabled features instead of dimming them', () => {
    const result = buildPreviewVisibility(data, {
      visibleLayerStart: 0, visibleLayerEnd: 2,
      activeMoveStart: 0, activeMoveEnd: 10,
      showTravel: false, dimPreviousLayers: false,
      featureVisibility: { 1: false },
    });
    expect(Array.from(result.visible)).toEqual([1, 0, 1, 0, 0, 0]);
  });

  it('finds the last move at or before the active end', () => {
    expect(maxMoveOrderForLayer(data, 1)).toBe(2);
    expect(lastMovePosition(data, 1, 1)).toEqual([3, 0, 0]);
    expect(lastMovePosition(data, 8, 0)).toBeNull();
  });

  it('only claims keyboard shortcuts for the focused viewport', () => {
    const viewport = document.createElement('div');
    const canvas = document.createElement('canvas'); viewport.append(canvas);
    const button = document.createElement('button'); viewport.append(button);
    expect(previewViewportOwnsKeyboardFocus(canvas, viewport, viewport)).toBe(true);
    expect(previewViewportOwnsKeyboardFocus(button, viewport, viewport)).toBe(false);
    expect(previewViewportOwnsKeyboardFocus(canvas, viewport, button)).toBe(true);
    expect(previewViewportOwnsKeyboardFocus(document.body, viewport, document.body)).toBe(false);
  });
});
