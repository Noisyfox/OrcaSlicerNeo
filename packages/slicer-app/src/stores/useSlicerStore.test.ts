import { describe, it, expect } from 'vitest';
import { useSlicerStore } from './useSlicerStore';

describe('useSlicerStore', () => {
  it('tracks slice status and scrubber range', () => {
    const s = useSlicerStore.getState();
    s.setStatus('slicing');
    s.setProgress(42);
    s.setLayers(80);
    s.setMaxLayer(79);
    s.setLayer(40);
    expect(useSlicerStore.getState().status).toBe('slicing');
    expect(useSlicerStore.getState().progress).toBe(42);
    expect(useSlicerStore.getState().layer).toBe(40);
  });

  it('invalidates every renderer-visible slice result field in one update', () => {
    useSlicerStore.setState({
      status: 'done', progress: 100, layers: 80, error: 'old error',
      resultExported: true, layer: 40, maxLayer: 79,
    });
    let updates = 0;
    const unsubscribe = useSlicerStore.subscribe(() => { updates += 1; });

    useSlicerStore.getState().invalidateSliceResult();
    unsubscribe();

    expect(updates).toBe(1);
    expect(useSlicerStore.getState()).toMatchObject({
      status: 'idle', progress: 0, layers: 0, error: null,
      resultExported: false, layer: 0, maxLayer: 0,
    });
  });

  it('keeps the visible layer range and move end inclusive, and resets ephemeral controls', () => {
    useSlicerStore.getState().setPreviewBounds(4, 8, 42);
    useSlicerStore.getState().setPreviewLayerRange([1, 3]);
    useSlicerStore.getState().setPreviewMoveEnd(6);
    useSlicerStore.getState().setPreviewShowTravel(false);
    useSlicerStore.getState().setPreviewFeatureVisibility(7, false);
    expect(useSlicerStore.getState().preview).toMatchObject({
      visibleLayerStart: 1, visibleLayerEnd: 3, activeMoveEnd: 6,
      showTravel: false, resultId: 42,
    });
    useSlicerStore.getState().resetPreviewState();
    expect(useSlicerStore.getState().preview).toMatchObject({
      visibleLayerStart: 0, visibleLayerEnd: 0,
      activeMoveEnd: 0, showTravel: true, dimPreviousLayers: true,
      featureVisibility: {}, resultId: null,
    });
  });

  it('normalizes move bounds to the newly active layer atomically', () => {
    useSlicerStore.getState().setPreviewBounds(2, 10, 43);
    useSlicerStore.getState().setPreviewMoveEnd(10);
    useSlicerStore.getState().setPreviewLayerEnd(1, 2);
    expect(useSlicerStore.getState().preview).toMatchObject({
      visibleLayerEnd: 1,
      maxMove: 2,
      activeMoveEnd: 2,
    });
    useSlicerStore.getState().setPreviewMoveEnd(1);
    expect(useSlicerStore.getState().preview.activeMoveEnd).toBe(1);
  });

  it('keeps a single-layer range paired when either layer thumb changes', () => {
    useSlicerStore.getState().setPreviewBounds(4, 10, 44);
    useSlicerStore.getState().setPreviewLayerRange([1, 3], 2);
    useSlicerStore.getState().setPreviewSingleLayer(true);
    expect(useSlicerStore.getState().preview).toMatchObject({
      singleLayer: true, visibleLayerStart: 3, visibleLayerEnd: 3,
    });

    // The first-thumb-shaped update must be able to move down without being
    // clamped against the old end; both values remain a valid single layer.
    useSlicerStore.getState().setPreviewLayerRange([2, 3], 7);
    expect(useSlicerStore.getState().preview).toMatchObject({
      visibleLayerStart: 2, visibleLayerEnd: 2, maxMove: 7, activeMoveEnd: 7,
    });
    // And the second thumb can move independently in the other direction.
    useSlicerStore.getState().setPreviewLayerRange([2, 4], 1);
    expect(useSlicerStore.getState().preview).toMatchObject({
      visibleLayerStart: 4, visibleLayerEnd: 4, maxMove: 1, activeMoveEnd: 1,
    });
  });
});
