import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformCapabilities } from '@orca/platform-contract';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { useSettingsStore } from '../../../stores/useSettingsStore';

// The app package tests source files directly; the runtime package's public
// barrel aliases its generated client package only in host builds.  This
// action needs just errorText, so keep the unit test at its actual boundary.
vi.mock('@orca/slicer-runtime', () => ({
  errorText: (error: unknown) => error instanceof Error ? error.message : String(error),
}));

import { addHandyModel, addModel, addPrimitive, HANDY_MODELS } from './sceneActions';
import { useProjectStore } from '../../../stores/useProjectStore';

function platformFor(fileName: string, result: { ok: boolean; error?: string }) {
  const addModel = vi.fn(async () => result);
  const runProjectHistoryTransaction = vi.fn(async <T>(
    _label: string,
    _category: 'project' | 'context',
    _before: unknown,
    mutation: (transactionId: string) => Promise<T>,
    _after: unknown | (() => unknown | Promise<unknown>),
  ) => ({ result: await mutation('tx-1'), status: {} as never }));
  return {
    platform: {
      models: { pick: vi.fn(async () => ({ displayName: fileName, bytes: new Uint8Array([1]) })) },
      runtime: { addModel, runProjectHistoryTransaction },
    } as unknown as PlatformCapabilities,
    addModel,
  };
}

describe('scene add-model action', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useSlicerStore.setState({ status: 'idle', error: null, resultExported: false });
    useSettingsStore.setState({ values: {}, modelLoaded: false });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes the selected DRC basename to the runtime', async () => {
    const { platform, addModel: runtimeAdd } = platformFor('cube_att.drc', { ok: true });
    await addModel(platform, null);
    expect(runtimeAdd).toHaveBeenCalledWith(new Uint8Array([1]), 'drc', 'cube_att.drc');
    expect(useSettingsStore.getState().values.modelPath).toBe('cube_att.drc');
  });

  it('does not expose decoder diagnostics when DRC import fails', async () => {
    const { platform } = platformFor('broken.drc', { ok: false, error: 'Draco decoder detail' });
    await addModel(platform, null);
    expect(useSlicerStore.getState().error).toBe('Unable to import DRC file');
  });

  it('imports the bundled 3DBenchy resource through the normal model pipeline', async () => {
    const { platform, addModel: runtimeAdd } = platformFor('unused.stl', { ok: true });
    const fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([3, 13]).buffer,
    }));
    vi.stubGlobal('fetch', fetch);

    await addHandyModel(platform, null, HANDY_MODELS[4]);

    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/handy-models/3DBenchy.drc' }));
    expect(runtimeAdd).toHaveBeenCalledWith(Uint8Array.from([3, 13]), 'drc', '3DBenchy.drc');
    expect(useSettingsStore.getState()).toMatchObject({
      modelLoaded: true,
      values: { modelPath: '3DBenchy' },
    });
  });

  it('keeps all source files when importing a multi-file handy model', async () => {
    const { platform, addModel: runtimeAdd } = platformFor('unused.stl', { ok: true });
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => ({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([url.pathname.length]).buffer,
    })));

    await addHandyModel(platform, null, HANDY_MODELS[0]);

    expect(runtimeAdd).toHaveBeenNthCalledWith(
      1, Uint8Array.from(['/handy-models/OrcaCube_v2.drc'.length]), 'drc', 'OrcaCube_v2.drc',
    );
    expect(runtimeAdd).toHaveBeenNthCalledWith(
      2, Uint8Array.from(['/handy-models/OrcaPlug_v2.drc'.length]), 'drc', 'OrcaPlug_v2.drc',
    );
    expect(useSettingsStore.getState().values.modelPath).toBe('Orca Cube');
  });

  it('keeps filament mutations fenced while a primitive add is still publishing', async () => {
    let release!: (value: { ok: boolean }) => void;
    const addShape = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => { release = resolve; }));
    const runProjectHistoryTransaction = vi.fn(async (
      _label: string,
      _category: 'project',
      _before: unknown,
      mutation: (transactionId: string) => Promise<{ ok: boolean }>,
      _after: unknown,
    ) => ({ result: await mutation('tx-1'), status: null }));
    const platform = {
      runtime: { addShape, runProjectHistoryTransaction },
    } as unknown as PlatformCapabilities;

    const pending = addPrimitive(platform, null, 'Cube');
    await Promise.resolve();
    expect(useProjectStore.getState().sceneMutationPendingCount).toBe(1);

    release({ ok: true });
    await pending;
    expect(useProjectStore.getState().sceneMutationPendingCount).toBe(0);
  });

  it('does not modify the scene when a bundled asset cannot be fetched', async () => {
    const { platform, addModel: runtimeAdd } = platformFor('unused.stl', { ok: true });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));

    await addHandyModel(platform, null, HANDY_MODELS[4]);

    expect(runtimeAdd).not.toHaveBeenCalled();
    expect(useSlicerStore.getState().error).toBe('handy model asset request failed (404): 3DBenchy.drc');
    expect(useSettingsStore.getState().modelLoaded).toBe(false);
  });
});
