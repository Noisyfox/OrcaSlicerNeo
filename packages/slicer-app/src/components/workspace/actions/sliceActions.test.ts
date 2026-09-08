import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformCapabilities } from '@orca/platform-contract';
import type { PlateSessionSnapshot } from '@slicer/client';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { glVolumeCollection } from '../viewport/GLVolume';
import { sliceModel } from './sliceActions';

const plate1: PlateSessionSnapshot = {
  ok: true,
  version: 1,
  currentPlateId: 'plate-1',
  plates: [{ plateId: 'plate-1', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1', instanceIds: [1], valid: true }],
  inputRevisions: { 'plate-1': 1 },
};

const plate1Revision2: PlateSessionSnapshot = { ...plate1, inputRevisions: { 'plate-1': 2 } };

describe('sliceModel late-result lifecycle', () => {
  beforeEach(() => {
    glVolumeCollection.clear();
    usePlateSessionStore.getState().reset();
    useSettingsStore.setState({ metadata: {}, values: {}, modelLoaded: true });
    useSlicerStore.getState().invalidateSliceResult();
  });

  it('drops a native-revision-mismatched result while preserving an unaffected completed plate', async () => {
    const cached = { ok: true, objects: 1, layers: 1, toolpath: {}, metadata: {} } as any;
    const unaffectedTarget = { plateId: 'plate-2', inputRevision: 4 };
    useSlicerStore.getState().setPlateResult(unaffectedTarget, cached, new Uint8Array([2]));
    useSlicerStore.getState().setSliceTarget(unaffectedTarget);
    useSlicerStore.getState().setStatus('done');
    useSlicerStore.getState().setProgress(100);
    usePlateSessionStore.getState().setSnapshot(plate1);

    const getPlateSessionSnapshot = vi.fn()
      .mockResolvedValueOnce(plate1)
      .mockResolvedValueOnce(plate1Revision2);
    const slicePlate = vi.fn(async () => ({ ok: true as const, unrecognized_keys: [] }));
    const runtime = {
      setModelTransform: vi.fn(async () => ({ ok: true })),
      getPlateSessionSnapshot,
      slicePlate,
      getSliceResult: vi.fn(async () => {
        // Model the real mutation boundary while preview extraction is in
        // flight, after the initial active-target guard has passed.
        useSlicerStore.getState().invalidatePlateResults(['plate-1']);
        return cached;
      }),
      exportGcodePlate: vi.fn(async () => ({ ok: true as const, path: '/tmp/late.gcode', bytes: new Uint8Array([1]) })),
    };

    await sliceModel({ runtime } as unknown as PlatformCapabilities);

    expect(slicePlate).toHaveBeenCalledOnce();
    expect(runtime.getSliceResult).toHaveBeenCalledOnce();
    expect(runtime.exportGcodePlate).toHaveBeenCalledOnce();
    expect(getPlateSessionSnapshot).toHaveBeenCalledTimes(2);
    expect(useSlicerStore.getState().plateResults).toEqual({ 'plate-2': expect.objectContaining({ target: unaffectedTarget }) });
    expect(useSlicerStore.getState().activeSliceTarget).toBeNull();
    expect(useSlicerStore.getState().sliceTarget).toEqual(unaffectedTarget);
    expect(useSlicerStore.getState().status).toBe('done');
    expect(useSlicerStore.getState().progress).toBe(100);
  });
});
