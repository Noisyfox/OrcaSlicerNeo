import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelSlice, sliceModel } from './sliceActions';
import { glVolumeCollection } from '../viewport/GLVolume';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useSlicerStore } from '@/stores/useSlicerStore';

describe('slice result publication', () => {
  beforeEach(() => {
    glVolumeCollection.volumes = [];
    usePlateSessionStore.getState().reset();
    useSettingsStore.setState({ metadata: {}, values: {} });
    useSlicerStore.getState().invalidateSliceResult();
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
