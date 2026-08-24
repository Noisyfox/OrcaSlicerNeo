import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlicerRuntime } from '@orca/platform-contract';
import { useObjectListStore } from './useObjectListStore';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { waitForSettledModelTransforms } from '../toolbar/persistModelTransforms';
import {
  changePartTypeInList,
  renameObjectInList,
  setObjectPrintableInList,
} from './actions';

vi.mock('../toolbar/persistModelTransforms', () => ({
  waitForSettledModelTransforms: vi.fn(async () => ({ ok: true })),
}));

const structure = {
  ok: true as const,
  objects: [{
    id: 1, index: 0, name: 'Cube', printable: true, instanceCount: 1,
    volumes: [{ id: 10, index: 0, name: 'Part', type: 'model_part' as const, isSplittable: false }],
    instances: [{ id: 20, index: 0, printable: true }],
  }],
};

function makeRuntime(overrides: Partial<SlicerRuntime> = {}): SlicerRuntime {
  return {
    renameObject: vi.fn(async () => ({ ok: true })),
    setVolumeType: vi.fn(async () => ({ ok: true })),
    setObjectPrintable: vi.fn(async () => ({ ok: true })),
    getModelStructure: vi.fn(async () => structure),
    ...overrides,
  } as unknown as SlicerRuntime;
}

describe('object list action helpers', () => {
  beforeEach(() => {
    vi.mocked(waitForSettledModelTransforms).mockReset();
    vi.mocked(waitForSettledModelTransforms).mockResolvedValue({ ok: true });
    useObjectListStore.setState({ structure: [], loaded: false, expanded: {}, projection: { objectIds: new Set(), volumeIds: new Set(), instanceIds: new Set() } });
    useSlicerStore.setState({ status: 'done', resultExported: true, error: 'stale', layers: 40 });
    useSettingsStore.setState({ modelLoaded: true, modelRevision: 3 });
  });

  it('renameObjectInList calls the bridge and refreshes structure + invalidates slice', async () => {
    const runtime = makeRuntime();
    const r = await renameObjectInList(runtime, 1, 'Renamed');
    expect(r).toEqual({ ok: true });
    expect(runtime.renameObject).toHaveBeenCalledWith(1, 'Renamed');
    expect(useObjectListStore.getState().structure).toHaveLength(1);
    expect(useSlicerStore.getState().status).toBe('idle');
    expect(useSlicerStore.getState().resultExported).toBe(false);
    expect(useSlicerStore.getState().error).toBeNull();
  });

  it('waits for pending transforms before invoking the metadata bridge', async () => {
    let release!: (result: { ok: boolean }) => void;
    vi.mocked(waitForSettledModelTransforms).mockReturnValueOnce(new Promise((resolve) => {
      release = resolve;
    }));
    const runtime = makeRuntime();
    const mutation = renameObjectInList(runtime, 1, 'Renamed');

    await Promise.resolve();
    expect(runtime.renameObject).not.toHaveBeenCalled();

    release({ ok: true });
    await mutation;
    expect(runtime.renameObject).toHaveBeenCalledWith(1, 'Renamed');
  });

  it('changePartTypeInList triggers a geometry refresh (mesh reload)', async () => {
    const runtime = makeRuntime();
    const before = useSettingsStore.getState().modelRevision;
    await changePartTypeInList(runtime, 10, 'negative_volume');
    expect(runtime.setVolumeType).toHaveBeenCalledWith(10, 'negative_volume');
    expect(useSettingsStore.getState().modelRevision).toBe(before + 1);
  });

  it('setObjectPrintableInList toggles printable and refreshes', async () => {
    const runtime = makeRuntime();
    const r = await setObjectPrintableInList(runtime, 1, false);
    expect(r).toEqual({ ok: true });
    expect(runtime.setObjectPrintable).toHaveBeenCalledWith(1, false);
    expect(useSlicerStore.getState().status).toBe('idle');
  });

  it('propagates a bridge error without refreshing', async () => {
    const runtime = makeRuntime({
      renameObject: vi.fn(async () => ({ ok: false, error: 'object not found' })),
    });
    const r = await renameObjectInList(runtime, 99, 'X');
    expect(r).toEqual({ ok: false, error: 'object not found' });
    expect(useSlicerStore.getState().status).toBe('done');
  });

  it('aborts the mutation when pending transform persistence fails', async () => {
    vi.mocked(waitForSettledModelTransforms).mockResolvedValueOnce({
      ok: false,
      error: 'transform sync failed',
    });
    const runtime = makeRuntime();
    const r = await renameObjectInList(runtime, 1, 'Renamed');

    expect(r).toEqual({ ok: false, error: 'transform sync failed' });
    expect(runtime.renameObject).not.toHaveBeenCalled();
    expect(useSlicerStore.getState().status).toBe('done');
  });
});
