import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import { persistSettledModelTransforms } from './persistModelTransforms';

const syncModelTransforms = vi.hoisted(() => vi.fn());
const applyPlateSessionTransforms = vi.hoisted(() => vi.fn());

vi.mock('./syncModelTransforms', () => ({
  syncModelTransforms,
  applyPlateSessionTransforms,
}));

describe('persistSettledModelTransforms', () => {
  beforeEach(() => {
    useSlicerStore.setState({
      status: 'done', progress: 100, layers: 80, error: null, resultExported: true,
    });
    syncModelTransforms.mockReset();
    useProjectStore.getState().reset();
  });

  it('invalidates the slicer result after a successful transform sync', async () => {
    syncModelTransforms.mockResolvedValue({ ok: true });
    const result = await persistSettledModelTransforms({} as never);
    expect(result).toEqual({ ok: true });
    const slicer = useSlicerStore.getState();
    expect(slicer.status).toBe('idle');
    expect(slicer.resultExported).toBe(false);
    expect(slicer.layers).toBe(0);
    expect(slicer.progress).toBe(0);
  });

  it('keeps a completed result when the transform sync fails', async () => {
    syncModelTransforms.mockResolvedValue({ ok: false, error: 'transform failed' });
    const result = await persistSettledModelTransforms({} as never);
    expect(result).toEqual({ ok: false, error: 'transform failed' });
    expect(useSlicerStore.getState().status).toBe('done');
  });

  it('records bridge revisions and reasons from a committed transform', async () => {
    syncModelTransforms.mockResolvedValue({
      ok: true,
      plateSession: {
        inputRevisions: { 'plate-1': 4, 'plate-2': 1 },
        dirtyReasons: ['model-transform'],
        instanceTransforms: [],
      },
    });
    await persistSettledModelTransforms({} as never);
    expect(useProjectStore.getState()).toMatchObject({
      dirty: true,
      dirtyReasons: ['model-transform'],
      plateInputRevisions: { 'plate-1': 4, 'plate-2': 1 },
    });
  });
});
