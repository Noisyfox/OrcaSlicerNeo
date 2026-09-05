import { describe, expect, it, vi } from 'vitest';
import type { ModelTransform } from '@slicer/client';
import { syncModelTransforms } from './syncModelTransforms';

const transform = (offset: [number, number, number]): ModelTransform => ({
  offset,
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  mirror: [1, 1, 1],
});

describe('syncModelTransforms', () => {
  it('synchronizes every composite, including sibling volumes of each instance', async () => {
    const setModelTransform = vi.fn().mockResolvedValue({ ok: true });
    const volumes = [
      { buffer: { objectIdx: 0, volumeIdx: 0, instanceIdx: 0 }, instanceTransform: transform([0, 0, 0]), volumeTransform: transform([0, 0, 0]) },
      { buffer: { objectIdx: 0, volumeIdx: 1, instanceIdx: 0 }, instanceTransform: transform([0, 0, 0]), volumeTransform: transform([1, 0, 0]) },
      { buffer: { objectIdx: 0, volumeIdx: 0, instanceIdx: 1 }, instanceTransform: transform([50, 0, 0]), volumeTransform: transform([0, 0, 0]) },
      { buffer: { objectIdx: 0, volumeIdx: 1, instanceIdx: 1 }, instanceTransform: transform([50, 0, 0]), volumeTransform: transform([1, 0, 0]) },
    ];

    await expect(syncModelTransforms({ setModelTransform }, volumes)).resolves.toEqual({ ok: true });
    expect(setModelTransform).toHaveBeenCalledTimes(4);
    expect(setModelTransform.mock.calls.map(([objectIdx, volumeIdx, instanceIdx]) => [objectIdx, volumeIdx, instanceIdx]))
      .toEqual([[0, 0, 0], [0, 1, 0], [0, 0, 1], [0, 1, 1]]);
  });

  it('captures the settled transform before asynchronous bridge writes begin', async () => {
    let resolveFirstWrite: ((result: { ok: boolean }) => void) | undefined;
    const setModelTransform = vi.fn().mockImplementation(() => new Promise<{ ok: boolean }>((resolve) => {
      resolveFirstWrite = resolve;
    }));
    const volumes = [
      {
        buffer: { objectIdx: 0, volumeIdx: 0, instanceIdx: 0 },
        instanceTransform: transform([12, 0, 0]),
        volumeTransform: transform([0, 0, 0]),
      },
    ];

    const sync = syncModelTransforms({ setModelTransform }, volumes);
    volumes[0].instanceTransform.offset[0] = 99;
    resolveFirstWrite?.({ ok: true });

    await expect(sync).resolves.toEqual({ ok: true });
    expect(setModelTransform).toHaveBeenCalledWith(
      0,
      0,
      0,
      transform([12, 0, 0]),
      transform([0, 0, 0]),
    );
  });

  it('recomputes membership once after the complete global transform snapshot', async () => {
    const setModelTransform = vi.fn().mockResolvedValue({ ok: true });
    const recomputePlateMembership = vi.fn().mockResolvedValue({
      ok: true,
      version: 1,
      currentPlateId: 'plate-1',
      plates: [],
      instanceTransforms: [],
      inputRevisions: { 'plate-1': 4 },
      affectedPlateIdsBefore: ['plate-1'],
      affectedPlateIdsAfter: ['plate-2'],
      affectedPlateIds: ['plate-1', 'plate-2'],
      dirtyReasons: ['model-transform'],
    });
    const volumes = [
      { buffer: { objectIdx: 0, volumeIdx: 0, instanceIdx: 0 }, instanceTransform: transform([1, 0, 0]), volumeTransform: transform([0, 0, 0]) },
      { buffer: { objectIdx: 1, volumeIdx: 0, instanceIdx: 0 }, instanceTransform: transform([2, 0, 0]), volumeTransform: transform([0, 0, 0]) },
    ];

    await expect(syncModelTransforms({ setModelTransform, recomputePlateMembership }, volumes)).resolves.toMatchObject({
      ok: true,
      plateSession: { inputRevisions: { 'plate-1': 4 }, affectedPlateIds: ['plate-1', 'plate-2'] },
    });
    expect(setModelTransform).toHaveBeenCalledTimes(2);
    expect(recomputePlateMembership).toHaveBeenCalledTimes(1);
  });
});
