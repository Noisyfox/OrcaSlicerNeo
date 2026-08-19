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
});
