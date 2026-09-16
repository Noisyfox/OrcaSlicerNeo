import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformCapabilities } from '@orca/platform-contract';
import type { PlateSessionSnapshot } from '@slicer/client';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { glVolumeCollection } from '../viewport/GLVolume';
import { exportGcode, sliceModel } from './sliceActions';

const plate1: PlateSessionSnapshot = {
  ok: true,
  version: 1,
  currentPlateId: 'plate-1',
  plates: [{ plateId: 'plate-1', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1', instanceIds: [1], valid: true }],
  inputRevisions: { 'plate-1': 1 },
};

describe('sliceModel result boundary', () => {
  beforeEach(() => {
    glVolumeCollection.clear();
    usePlateSessionStore.getState().reset();
    useSettingsStore.setState({ metadata: {}, values: {}, modelLoaded: true });
    useSlicerStore.getState().invalidateSliceResult();
  });

  it('publishes a lightweight receipt and releases the global job before projection or export', async () => {
    const unaffectedTarget = { plateId: 'plate-2', inputRevision: 4 };
    useSlicerStore.getState().setPlateResult({ plateId: 'plate-2', inputStamp: 4, sliceTaskId: 'old' });
    useSlicerStore.getState().setSliceTarget(unaffectedTarget);
    useSlicerStore.getState().setStatus('done');
    useSlicerStore.getState().setProgress(100);
    usePlateSessionStore.getState().setSnapshot(plate1);

    const getPlateSessionSnapshot = vi.fn().mockResolvedValue(plate1);
    const receipt = { plateId: 'plate-1', inputStamp: 1, sliceTaskId: '17' };
    const slicePlate = vi.fn(async () => ({ ok: true as const, unrecognized_keys: [], receipt }));
    const runtime = {
      setModelTransform: vi.fn(async () => ({ ok: true })),
      getPlateSessionSnapshot,
      slicePlate,
      getSliceResult: vi.fn(),
      exportGcodePlate: vi.fn(async () => ({ ok: true as const, path: '/tmp/late.gcode', bytes: new Uint8Array([1]) })),
    };

    await sliceModel({ runtime } as unknown as PlatformCapabilities);

    expect(slicePlate).toHaveBeenCalledOnce();
    expect(runtime.getSliceResult).not.toHaveBeenCalled();
    expect(runtime.exportGcodePlate).not.toHaveBeenCalled();
    expect(getPlateSessionSnapshot).toHaveBeenCalledOnce();
    expect(useSlicerStore.getState().plateResults).toEqual({
      'plate-2': expect.objectContaining({ target: unaffectedTarget }),
      'plate-1': expect.objectContaining({ receipt }),
    });
    expect(useSlicerStore.getState().activeSliceTarget).toBeNull();
    expect(useSlicerStore.getState().sliceTarget).toEqual({ plateId: 'plate-1', inputRevision: 1 });
    expect(useSlicerStore.getState().status).toBe('done');
    expect(useSlicerStore.getState().progress).toBe(100);
  });

  it('exports the current retained native result without renderer-owned G-code bytes', async () => {
    const receipt = { plateId: 'plate-1', inputStamp: 1, sliceTaskId: '23' };
    usePlateSessionStore.getState().setSnapshot(plate1);
    useSlicerStore.getState().setPlateResult(receipt);
    useSlicerStore.getState().activatePlateResult('plate-1', 1);
    const bytes = new Uint8Array([7, 8, 9]);
    const exportGcodePlate = vi.fn(async () => ({ ok: true as const, path: '/out.gcode', bytes }));
    const save = vi.fn(async () => undefined);
    const platform = {
      runtime: { getPlateSessionSnapshot: vi.fn(async () => plate1), exportGcodePlate },
      exports: { save },
    } as unknown as PlatformCapabilities;

    await exportGcode(platform);

    expect(exportGcodePlate).toHaveBeenCalledWith({ plateId: 'plate-1', inputRevision: 1 });
    expect(save).toHaveBeenCalledWith('output.gcode', bytes);
    expect(useSlicerStore.getState().resultExported).toBe(true);
  });
});
