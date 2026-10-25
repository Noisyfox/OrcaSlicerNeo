import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { NozzleMappingSnapshot } from '@slicer/client';
import { sliceModel } from '../actions/sliceActions';
import { mappingConfirmation } from './mappingConfirmation';
import { commitNozzleMapping } from './nozzleMappingActions';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { useHistoryNavigationStore } from '@/stores/useHistoryNavigationStore';
import { glVolumeCollection } from '../viewport/GLVolume';
vi.mock('./nozzleMappingActions', () => ({ commitNozzleMapping: vi.fn() }));

const snapshot = (mode: 0 | 1 | 2 | 3 = 2): NozzleMappingSnapshot => ({
  ok: true, plateId: 'A', revision: 10, eligible: true,
  nozzles: [1, 2].map(id => ({ id, diameter: 0.4, capacity: 1 })), usedFilaments: [1, 2],
  modes: [0, 1, 2, 3].map(m => ({ mode: m as 0 | 1 | 2 | 3, available: m !== 1, reason: m === 1 ? 'Synchronization unavailable' : '' })),
  saved: { mode, filamentMap: [1, 1], volumeMap: null, nozzleMap: null },
  effective: { mode, filamentMap: [1, 1], volumeMap: [0, 0], nozzleMap: [0, 0] }, diagnostics: [],
});
function fixture(mapping = snapshot()) {
  const session = { ok: true as const, version: 1 as const, currentPlateId: 'A', instances: [], inputRevisions: { A: 10 },
    plates: [{ plateId: 'A', name: 'Plate A', displayIndex: 0, origin: [0, 0, 0] as [number, number, number], instanceIds: [1] }] };
  usePlateSessionStore.getState().setSnapshot(session);
  const runtime = {
    getPlateSessionSnapshot: vi.fn(async () => session),
    getNozzleMapping: vi.fn(async () => mapping),
    getHistoryStatus: vi.fn(async () => ({ revision: 42, dirty: false, canUndo: false, canRedo: false, undoEntries: [], redoEntries: [] })),
    slicePlate: vi.fn(async (target: { plateId: string; inputRevision: number }) => ({
      ok: true, unrecognized_keys: [], receipt: { plateId: target.plateId, inputStamp: target.inputRevision, resultGeneration: '1', sliceTaskId: '1' },
    })),
  };
  return { platform: { runtime } as never, runtime };
}
beforeEach(() => {
  vi.clearAllMocks(); glVolumeCollection.volumes = [];
  useHistoryNavigationStore.getState().reset();
  useSlicerStore.getState().invalidateSliceResult();
  useSettingsStore.setState({ metadata: {}, values: {} });
});
afterEach(() => mappingConfirmation.cancel());
async function dialog() { await vi.waitFor(() => expect(mappingConfirmation.getSnapshot()).not.toBeNull()); return mappingConfirmation.getSnapshot()!; }

it('cancel and duplicate admission save no draft and start no slice', async () => {
  const { platform, runtime } = fixture();
  const task = sliceModel(platform);
  const request = await dialog();
  await sliceModel(platform);
  mappingConfirmation.finish(request, null);
  await task;
  expect(runtime.getNozzleMapping).toHaveBeenCalledOnce();
  expect(commitNozzleMapping).not.toHaveBeenCalled(); expect(runtime.slicePlate).not.toHaveBeenCalled();
  expect(useSlicerStore.getState().status).toBe('idle');
});

it('confirms one complete map and slices exactly the committed Plate revision', async () => {
  const mapping = snapshot(); const { platform, runtime } = fixture(mapping);
  vi.mocked(commitNozzleMapping).mockResolvedValueOnce({ ok: true, changed: true, snapshot: { ...mapping, revision: 11 } } as never);
  const task = sliceModel(platform);
  mappingConfirmation.finish(await dialog(), [2, 1]);
  await task;
  expect(commitNozzleMapping).toHaveBeenCalledExactlyOnceWith(platform, mapping, 42, { kind: 'mapping', filamentMap: [2, 1] });
  expect(runtime.slicePlate).toHaveBeenCalledExactlyOnceWith({ plateId: 'A', inputRevision: 11 }, {}, expect.any(Function));
  expect(useSlicerStore.getState().plateResults.A.receipt?.inputStamp).toBe(11);
});

it('unchanged Nozzle Manual confirms without changing mode or inventing a new revision', async () => {
  const mapping = snapshot(3); const { platform, runtime } = fixture(mapping);
  vi.mocked(commitNozzleMapping).mockResolvedValueOnce({ ok: true, changed: false, snapshot: mapping } as never);
  const task = sliceModel(platform); mappingConfirmation.finish(await dialog(), [1, 1]); await task;
  expect(commitNozzleMapping).toHaveBeenCalledWith(platform, mapping, 42, { kind: 'mapping', filamentMap: [1, 1] });
  expect(runtime.slicePlate.mock.calls[0][0].inputRevision).toBe(10);
});

it('rejected or stale confirmation cannot start a slice', async () => {
  const { platform, runtime } = fixture();
  vi.mocked(commitNozzleMapping).mockRejectedValueOnce(new Error('Plate no longer exists'));
  const task = sliceModel(platform); mappingConfirmation.finish(await dialog(), [2, 1]); await task;
  expect(runtime.slicePlate).not.toHaveBeenCalled();
  expect(useSlicerStore.getState().error).toContain('Plate no longer exists');
});

it('automatic bypasses the dialog, while an unavailable mode cannot bypass admission', async () => {
  const auto = fixture(snapshot(0)); await sliceModel(auto.platform);
  expect(auto.runtime.slicePlate).toHaveBeenCalledOnce(); expect(mappingConfirmation.getSnapshot()).toBeNull();
  useSlicerStore.getState().invalidateSliceResult();
  const unavailable = fixture(snapshot(1)); await sliceModel(unavailable.platform);
  expect(unavailable.runtime.slicePlate).not.toHaveBeenCalled(); expect(commitNozzleMapping).not.toHaveBeenCalled();
  expect(useSlicerStore.getState().error).toBe('Synchronization unavailable');
});

it('a native rejection after commit never retargets to a newer revision', async () => {
  const mapping = snapshot(); const { platform, runtime } = fixture(mapping);
  vi.mocked(commitNozzleMapping).mockResolvedValueOnce({ ok: true, changed: false, snapshot: mapping } as never);
  runtime.slicePlate.mockResolvedValueOnce({ ok: false, error: 'stale plate input revision' } as never);
  const task = sliceModel(platform); mappingConfirmation.finish(await dialog(), [1, 1]); await task;
  expect(runtime.slicePlate).toHaveBeenCalledTimes(1);
  expect(runtime.slicePlate.mock.calls[0][0]).toEqual({ plateId: 'A', inputRevision: 10 });
  expect(useSlicerStore.getState().plateResults.A?.receipt).toBeUndefined();
});

it('rejects a projection that already belongs to changed inputs', async () => {
  const { platform, runtime } = fixture({ ...snapshot(), revision: 11 });
  await sliceModel(platform);
  expect(mappingConfirmation.getSnapshot()).toBeNull(); expect(runtime.slicePlate).not.toHaveBeenCalled();
});

it('cancel preserves an existing valid result when an explicit reslice was requested', async () => {
  const { platform, runtime } = fixture();
  const receipt = { plateId: 'A', inputStamp: 10, resultGeneration: 'existing', sliceTaskId: 'old' };
  useSlicerStore.getState().setPlateResult(receipt, [], {});
  useSlicerStore.getState().activatePlateResult('A', 10);
  const task = sliceModel(platform, 'A');
  mappingConfirmation.finish(await dialog(), null);
  await task;
  expect(runtime.slicePlate).not.toHaveBeenCalled();
  expect(useSlicerStore.getState().plateResults.A.receipt).toEqual(receipt);
  expect(useSlicerStore.getState().status).toBe('done');
});
