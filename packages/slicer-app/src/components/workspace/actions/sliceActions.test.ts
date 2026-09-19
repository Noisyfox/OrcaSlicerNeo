import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sliceModel } from './sliceActions';
import { glVolumeCollection } from '../viewport/GLVolume';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { useSlicerStore } from '../../../stores/useSlicerStore';

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
});
