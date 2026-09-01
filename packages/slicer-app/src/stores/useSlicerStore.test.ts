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

  it('keeps preview ranges inclusive and resets ephemeral controls', () => {
    useSlicerStore.getState().setPreviewBounds(4, 8, 42);
    useSlicerStore.getState().setPreviewLayerRange([1, 3]);
    useSlicerStore.getState().setPreviewMoveRange([2, 6]);
    useSlicerStore.getState().setPreviewShowTravel(false);
    useSlicerStore.getState().setPreviewFeatureVisibility(7, false);
    expect(useSlicerStore.getState().preview).toMatchObject({
      visibleLayerStart: 1, visibleLayerEnd: 3, activeMoveStart: 2,
      activeMoveEnd: 6, showTravel: false, resultId: 42,
    });
    useSlicerStore.getState().resetPreviewState();
    expect(useSlicerStore.getState().preview).toMatchObject({
      visibleLayerStart: 0, visibleLayerEnd: 0, activeMoveStart: 0,
      activeMoveEnd: 0, showTravel: true, dimPreviousLayers: true,
      featureVisibility: {}, resultId: null,
    });
  });
});
