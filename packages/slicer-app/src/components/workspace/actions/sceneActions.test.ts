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

import { addDroppedModels, addHandyModel, addModel, addPrimitive, clearScene, HANDY_MODELS, notifyModelAdded } from './sceneActions';
import { useProjectStore } from '../../../stores/useProjectStore';

function platformFor(fileName: string, result: { ok: boolean; error?: string }) {
  const addModel = vi.fn(async (_bytes: Uint8Array, _ext: string, _name: string) => result);
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
      runtime: {
        addModel,
        runProjectHistoryTransaction,
        getHistoryStatus: vi.fn(async () => ({ dirty: false })),
      },
    } as unknown as PlatformCapabilities,
    addModel,
  };
}

describe('scene add-model action', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useSlicerStore.setState({ status: 'idle', error: null, resultExported: false });
    useSettingsStore.setState({ values: {}, modelLoaded: false });
    useProjectStore.getState().resetOperation();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes the selected DRC basename to the runtime', async () => {
    const { platform, addModel: runtimeAdd } = platformFor('cube_att.drc', { ok: true });
    await expect(addModel(platform, null)).resolves.toBe(true);
    expect(runtimeAdd).toHaveBeenCalledWith(new Uint8Array([1]), 'drc', 'cube_att.drc');
    expect(useSettingsStore.getState().values.modelPath).toBe('cube_att.drc');
  });

  it('does not expose decoder diagnostics when DRC import fails', async () => {
    const { platform } = platformFor('broken.drc', { ok: false, error: 'Draco decoder detail' });
    await expect(addModel(platform, null)).resolves.toBe(false);
    expect(useSlicerStore.getState().error).toBe('Unable to import DRC file');
  });

  it('notifies the shell only when an add operation changed the scene', () => {
    const onModelAdded = vi.fn();
    notifyModelAdded(true, onModelAdded);
    notifyModelAdded(false, onModelAdded);
    expect(onModelAdded).toHaveBeenCalledOnce();
  });

  it.each(['broken.step', 'broken.stp'])('maps native %s failures to the generic STEP error', async (fileName) => {
    const { platform } = platformFor(fileName, { ok: false, error: 'OCCT diagnostic detail' });
    await expect(addModel(platform, null)).resolves.toBe(false);
    expect(useSlicerStore.getState().error).toBe('Unable to import STEP file');
  });

  it('routes externally dropped STL and STEP files through the shared runtime add path', async () => {
    const { platform, addModel: runtimeAdd } = platformFor('unused.stl', { ok: true });
    await addDroppedModels(platform, null, [
      { displayName: 'cube.stl', bytes: Uint8Array.from([1]) },
      { displayName: 'part.step', bytes: Uint8Array.from([2]) },
    ]);
    expect(runtimeAdd).toHaveBeenNthCalledWith(1, Uint8Array.from([1]), 'stl', 'cube.stl');
    expect(runtimeAdd).toHaveBeenNthCalledWith(2, Uint8Array.from([2]), 'step', 'part.step');
    expect(useProjectStore.getState().operation).toMatchObject({ phase: 'completed', progress: 100 });
  });

  it('settles a cancelled picker import without showing a stale modal', async () => {
    const { platform } = platformFor('unused.stl', { ok: true });
    platform.models.pick = vi.fn(async () => null);
    await expect(addModel(platform, null)).resolves.toBe(false);
    expect(useProjectStore.getState().operation).toMatchObject({ phase: 'cancelled', progress: 0, cancellable: false });
  });

  it('reports deterministic completed-file progress for a dropped batch', async () => {
    const progressDuringImport: number[] = [];
    const addModel = vi.fn(async (_bytes: Uint8Array, _ext: string, _name: string) => {
      progressDuringImport.push(useProjectStore.getState().operation.progress);
      return { ok: true };
    });
    const runProjectHistoryTransaction = vi.fn(async <T>(
      _label: string,
      _category: 'project' | 'context',
      _before: unknown,
      mutation: (transactionId: string) => Promise<T>,
      _after: unknown | (() => unknown | Promise<unknown>),
    ) => ({ result: await mutation('tx-1'), status: {} as never }));
    const platform = { runtime: { addModel, runProjectHistoryTransaction } } as unknown as PlatformCapabilities;
    const load = vi.fn(async () => {
      expect(useProjectStore.getState().operation).toMatchObject({ phase: 'model-import', progress: 0 });
      return [
        { displayName: 'a.stl', bytes: Uint8Array.from([1]) },
        { displayName: 'b.stl', bytes: Uint8Array.from([2]) },
      ];
    });
    await expect(addDroppedModels(platform, null, load, 2)).resolves.toBe(true);
    expect(load).toHaveBeenCalledOnce();
    expect(progressDuringImport).toEqual([0, 50]);
    expect(useProjectStore.getState().operation).toMatchObject({ phase: 'completed', progress: 100, cancellable: false });
  });

  it('settles a partially failed dropped batch and retains the generic file error', async () => {
    const { platform, addModel } = platformFor('unused.stl', { ok: true });
    addModel.mockImplementation(async (_bytes: Uint8Array, _ext: string, name: string) => name === 'a.stl'
      ? { ok: true }
      : { ok: false, error: 'decoder detail' });
    await expect(addDroppedModels(platform, null, [
      { displayName: 'a.stl', bytes: Uint8Array.from([1]) },
      { displayName: 'b.stl', bytes: Uint8Array.from([2]) },
    ])).resolves.toBe(true);
    expect(useProjectStore.getState().operation).toMatchObject({ phase: 'failed', progress: 50, cancellable: false });
    expect(useSlicerStore.getState().error).toBe('decoder detail');
  });

  it('returns false for a wholly failed dropped batch so navigation stays unchanged', async () => {
    const { platform } = platformFor('unused.stl', { ok: false, error: 'decoder detail' });
    await expect(addDroppedModels(platform, null, [
      { displayName: 'broken.stl', bytes: Uint8Array.from([1]) },
    ])).resolves.toBe(false);
    expect(useProjectStore.getState().operation).toMatchObject({ phase: 'failed', progress: 0 });
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
    expect(useProjectStore.getState().projectMutationPendingCount).toBe(1);

    release({ ok: true });
    await pending;
    expect(useProjectStore.getState().projectMutationPendingCount).toBe(0);
  });

  it('keeps Clear Scene fenced through its single filament refresh', async () => {
    const pendingAtRefresh: number[] = [];
    const platform = {
      runtime: {
        clearModel: vi.fn(async () => ({ ok: true })),
        runProjectHistoryTransaction: vi.fn(async (
          _label: string,
          _category: 'project',
          _before: unknown,
          mutation: (transactionId: string) => Promise<{ ok: boolean }>,
          _after: unknown,
        ) => ({ result: await mutation('tx-1'), status: null })),
        getFilamentSessionSnapshot: vi.fn(async () => {
          pendingAtRefresh.push(useProjectStore.getState().projectMutationPendingCount);
          return { ok: true, version: 1, slots: [], mappings: {}, flushing: {}, capabilities: {},
            assignments: { objects: [], parts: [], modifiers: [] },
            revisions: { session: 1, project: 1, result: 0, plates: {} }, status: { state: 'ready', error: null } } as never;
        }),
      },
    } as unknown as PlatformCapabilities;
    useSettingsStore.setState({ modelLoaded: true });

    await clearScene(platform, null);

    expect(platform.runtime.getFilamentSessionSnapshot).toHaveBeenCalledOnce();
    expect(pendingAtRefresh).toEqual([1]);
    expect(useProjectStore.getState().projectMutationPendingCount).toBe(0);
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
