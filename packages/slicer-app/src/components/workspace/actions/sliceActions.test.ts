import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelSlice, sliceModel } from './sliceActions';
import { glVolumeCollection } from '../viewport/GLVolume';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useSlicerStore } from '@/stores/useSlicerStore';

describe('slice result publication', () => {
  it('slices an explicit non-current plate and preserves the selected plate result', async () => {
    const session = { ok: true as const, version: 1 as const, currentPlateId: 'a', instances: [], inputRevisions: { a: 1, b: 2 },
      plates: [{ plateId: 'a', name: 'Plate 1', displayIndex: 0, origin: [0, 0, 0] as [number, number, number], instanceIds: [1] },
        { plateId: 'b', name: 'Plate 2', displayIndex: 1, origin: [264, 0, 0] as [number, number, number], instanceIds: [2] }] };
    usePlateSessionStore.getState().setSnapshot(session);
    useSlicerStore.getState().setPlateResult({ plateId: 'a', inputStamp: 1, resultGeneration: '1', sliceTaskId: '1' }, [], {});
    useSlicerStore.getState().activatePlateResult('a', 1);
    const receipt = { plateId: 'b', inputStamp: 2, resultGeneration: '1', sliceTaskId: '2' };
    const runtime = { getPlateSessionSnapshot: vi.fn(async () => session),
      slicePlate: vi.fn(async () => ({ ok: true, unrecognized_keys: [], receipt, summary: { estimatedTimeSeconds: 12 } })) };
    await Promise.all([sliceModel({ runtime } as never, 'b'), sliceModel({ runtime } as never, 'b')]);
    expect(runtime.slicePlate).toHaveBeenCalledExactlyOnceWith({ plateId: 'b', inputRevision: 2 }, {}, expect.any(Function));
    expect(usePlateSessionStore.getState().snapshot?.currentPlateId).toBe('a');
    expect(useSlicerStore.getState()).toMatchObject({ status: 'done', sliceTarget: { plateId: 'a' },
      plateResults: { b: { receipt, summary: { estimatedTimeSeconds: 12 } } } });
  });
  beforeEach(() => {
    glVolumeCollection.volumes = [];
    usePlateSessionStore.getState().reset();
    useSettingsStore.setState({ metadata: {}, values: {} });
    useSlicerStore.getState().invalidateSliceResult();
  });

  it.each(['15', '15,25'])('leaves scene-owned tower coordinates out of Slice (cached X=%s)', async (x) => {
    useSettingsStore.setState({
      metadata: { wipe_tower_x: { type: 'floats' }, wipe_tower_y: { type: 'floats' },
        prime_tower_width: { type: 'float' } },
      values: { wipe_tower_x: x, wipe_tower_y: '220', prime_tower_width: '25', modelPath: 'cube.stl' },
    });
    const runtime = {
      getPlateSessionSnapshot: vi.fn(async () => ({
        instances: [], ok: true, currentPlateId: 'plate-1',
        plates: [{ plateId: 'plate-1', displayIndex: 0, origin: [0, 0, 0], instanceIds: [1] }],
        inputRevisions: { 'plate-1': 7 },
      })),
      slicePlate: vi.fn(async () => ({ ok: false, error: 'fixture terminal' })),
    };
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await sliceModel({ runtime } as never);
      expect(runtime.slicePlate).toHaveBeenCalledWith(
        { plateId: 'plate-1', inputRevision: 7 }, { prime_tower_width: '25' }, expect.any(Function),
      );
    } finally { errorLog.mockRestore(); }
  });

  it('suppresses a late cancelled terminal after history withdraws the active target', async () => {
    let resolveSlice!: (result: { ok: false; error: string }) => void;
    const sliceTerminal = new Promise<{ ok: false; error: string }>((resolve) => {
      resolveSlice = resolve;
    });
    const runtime = {
      getPlateSessionSnapshot: vi.fn(async () => ({
        instances: [],
        ok: true, currentPlateId: 'plate-1',
        plates: [{ plateId: 'plate-1', displayIndex: 0, origin: [0, 0, 0], instanceIds: [1] }],
        inputRevisions: { 'plate-1': 7 },
      })),
      slicePlate: vi.fn(() => sliceTerminal),
    };
    const task = sliceModel({ runtime } as never);
    await vi.waitFor(() => expect(useSlicerStore.getState().status).toBe('slicing'));

    useSlicerStore.getState().invalidateSliceResult();
    resolveSlice({ ok: false, error: 'cancelled' });
    await expect(task).resolves.toBeUndefined();

    expect(useSlicerStore.getState()).toMatchObject({
      status: 'idle', error: null, activeSliceTarget: null, plateResults: {},
    });
  });
  it.each([true, false])('retains the job until terminal; cancellation accepted=%s', async (accepted) => {
    let resolveSlice!: (result: { ok: false; error: string }) => void;
    const terminal = new Promise<{ ok: false; error: string }>(resolve => { resolveSlice = resolve; });
    const runtime = {
      getPlateSessionSnapshot: vi.fn(async () => ({
        instances: [], ok: true, currentPlateId: 'plate-1',
        plates: [{ plateId: 'plate-1', displayIndex: 0, origin: [0, 0, 0], instanceIds: [1] }],
        inputRevisions: { 'plate-1': 7 },
      })),
      slicePlate: vi.fn(() => terminal),
      cancel: vi.fn(async () => ({ ok: accepted, error: accepted ? undefined : 'Cancellation unsupported' })),
    };
    const task = sliceModel({ runtime } as never);
    await vi.waitFor(() => expect(runtime.slicePlate).toHaveBeenCalledOnce());
    expect(await cancelSlice({ runtime } as never)).toBe(accepted);
    expect(useSlicerStore.getState().status).toBe('slicing');
    expect(useSlicerStore.getState().activeSliceTarget).not.toBeNull();
    if (accepted) {
      expect(await cancelSlice({ runtime } as never)).toBe(false);
      expect(runtime.cancel).toHaveBeenCalledOnce();
    } else {
      expect(useSlicerStore.getState().error).toBe('Cancellation unsupported');
    }
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    resolveSlice({ ok: false, error: accepted ? 'cancelled' : 'Slice failed' });
    await task;
    expect(useSlicerStore.getState()).toMatchObject({
      status: accepted ? 'idle' : 'error', error: accepted ? null : 'Slice failed', activeSliceTarget: null, plateResults: {},
    });
    errorLog.mockRestore();
  });

});
