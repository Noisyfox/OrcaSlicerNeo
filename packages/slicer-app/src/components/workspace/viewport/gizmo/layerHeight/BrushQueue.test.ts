import { describe, expect, it, vi } from 'vitest';
import type { LayerHeightProfile, LayerHeightSample } from '@slicer/client';
import { BrushQueue } from './BrushQueue';

const profile = { objectId: 8, stamp: { plateId: 'p' } } as LayerHeightProfile;
const sample = (z: number): LayerHeightSample => ({ z, width: 2, action: 1 });

describe('layer height Worker queue', () => {
  function setup() {
    let resolve!: (id: number) => void;
    const promise = new Promise<number>(accept => { resolve = accept; });
    const runtime = {
      beginLayerHeightStroke: vi.fn(() => promise),
      sampleLayerHeightStroke: vi.fn().mockResolvedValue({}),
      cancelLayerHeightStroke: vi.fn().mockResolvedValue(undefined),
    };
    const display = vi.fn();
    return { begin: { resolve }, runtime, display, queue: new BrushQueue(runtime, profile, display) };
  }
  it('keeps repeated and moved samples until an off-bar release drains them', async () => {
    const { begin, runtime, queue, display } = setup();
    queue.append(sample(5)); queue.append(sample(5)); queue.append(sample(7));
    const end = queue.release();
    begin.resolve(2);
    const target = await end;
    expect(target).toEqual({ objectId: 8, plateId: 'p', strokeId: 2 });
    expect(runtime.sampleLayerHeightStroke).toHaveBeenCalledWith({ ...target, samples: [sample(5), sample(5), sample(7)] });
    expect(display).toHaveBeenCalledTimes(1);
  });
  it('discards pending input and releases a draft even if interrupted before opening', async () => {
    const { begin, runtime, queue, display } = setup();
    queue.append(sample(5));
    const end = queue.cancel();
    begin.resolve(2);
    await end;
    expect(runtime.cancelLayerHeightStroke).toHaveBeenCalledTimes(1);
    expect(runtime.sampleLayerHeightStroke).not.toHaveBeenCalled();
    expect(display).not.toHaveBeenCalled();
  });
});
