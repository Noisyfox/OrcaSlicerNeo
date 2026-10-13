import { createClient, type LoadModelResult } from '@slicer/client';
import { createMockModule } from '../../../../../slicer-wasm/src/client/testing/mock-module';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformCapabilities } from '@orca/platform-contract';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { useSettingsStore } from '@/stores/useSettingsStore';

// The app package tests source files directly; the runtime package's public
// barrel aliases its generated client package only in host builds.  This
// action needs just errorText, so keep the unit test at its actual boundary.
vi.mock('@orca/slicer-runtime', () => ({
  errorText: (error: unknown) => error instanceof Error ? error.message : String(error),
}));

import { addDroppedModels, addHandyModel, addModel, addPrimitive, clearScene, HANDY_MODELS } from './sceneActions';
import { useProjectStore } from '@/stores/useProjectStore';
import { glVolumeCollection } from '../viewport/GLVolume';

// Model loading is owned by the viewport; publish its revision at the store
// boundary so action tests exercise the same wait as production.
let unsubscribeModelPublication: (() => void) | undefined;
beforeEach(() => {
  glVolumeCollection.clear(useSettingsStore.getState().modelRevision);
  unsubscribeModelPublication = useSettingsStore.subscribe((state) => {
    glVolumeCollection.clear(state.modelRevision);
  });
});
afterEach(() => { unsubscribeModelPublication?.(); });

const modelSuccess = await createClient(async () => createMockModule()).addShape('Cube');
if (!modelSuccess.ok) throw new Error(modelSuccess.error);

function platformFor(fileName: string, result: { ok: boolean; error?: string }) {
  const addModel = vi.fn(async (_bytes: Uint8Array, _ext: string, _name: string) => result.ok ? modelSuccess : { ok: false as const, error: result.error ?? 'import failed' });
  const runProjectHistoryTransaction = vi.fn(async <T>(
    _label: string,
    _category: 'project',
    _before: unknown,
    mutation: (transactionId: string) => Promise<T>,
    _after: unknown | (() => unknown | Promise<unknown>),
  ) => ({ sceneDelta: { version: 1, objectIds: [1], volumeIds: [], instanceIds: [], plateIds: [], objectOrder: [1] }, result: await mutation('tx-1'), status: {} as never }));
  return {
    platform: {
      models: { pick: vi.fn(async () => ({ displayName: fileName, bytes: new Uint8Array([1]) })) },
      runtime: {
        addModel,
        runProjectHistoryTransaction,
        getModelScenePatch: vi.fn(async () => ({ ok: true, objectOrder: [1], objects: [{ id: 1, index: 0, name: 'fixture', printable: true, instanceCount: 0, volumes: [], instances: [] }], meshes: [], geometries: [], paintGeometries: [] })),
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

  it('notifies the shell from the shared picker action after a successful import', async () => {
    const { platform } = platformFor('cube.stl', { ok: true });
    const onModelAdded = vi.fn();

    await expect(addModel(platform, null, onModelAdded)).resolves.toBe(true);

    expect(onModelAdded).toHaveBeenCalledOnce();
  });

  it('does not notify the shell when the picker import is cancelled or fails', async () => {
    const cancelled = platformFor('cube.stl', { ok: true });
    cancelled.platform.models.pick = vi.fn(async () => null);
    const onCancelled = vi.fn();
    await expect(addModel(cancelled.platform, null, onCancelled)).resolves.toBe(false);
    expect(onCancelled).not.toHaveBeenCalled();

    const failed = platformFor('broken.stl', { ok: false, error: 'decoder detail' });
    const onFailed = vi.fn();
    await expect(addModel(failed.platform, null, onFailed)).resolves.toBe(false);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['failed', { ok: false, error: 'invalid native plate receipt' }],
  ])('does not publish model state from a %s native plate receipt', async (_label, receipt) => {
    const module = createMockModule();
    const ccall = module.ccall;
    module.ccall = (name, ret, types, args) => {
      const pointer = ccall(name, ret, types, args);
      if (name !== 'orc_add_model' && name !== 'orc_clear_model') return pointer;
      const payload = JSON.parse(module.UTF8ToString(Number(pointer)));
      module._free(Number(pointer));
      payload.plate_session = receipt;
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      const replacement = module._malloc(bytes.length + 1);
      module.HEAPU8.set(bytes, replacement);
      module.HEAPU8[replacement + bytes.length] = 0;
      return replacement;
    };
    const client = createClient(async () => module);
    const { platform } = platformFor('invalid.stl', { ok: true });
    platform.runtime.addModel = client.addModel;
    platform.runtime.clearModel = client.clearModel;
    useSettingsStore.setState({ modelLoaded: true, values: { modelPath: 'existing.stl' } });
    useProjectStore.getState().setProject({ hasContent: true });
    usePlateSessionStore.getState().setSnapshot(modelSuccess.plateSession);
    useSlicerStore.setState({ status: 'done', resultExported: true });
    const revision = useSettingsStore.getState().modelRevision;
    const onModelAdded = vi.fn();

    await expect(addModel(platform, null, onModelAdded)).resolves.toBe(false);
    await clearScene(platform, null);

    expect(onModelAdded).not.toHaveBeenCalled();
    expect(platform.runtime.getModelScenePatch).not.toHaveBeenCalled();
    expect(useSettingsStore.getState()).toMatchObject({ modelLoaded: true, modelRevision: revision, values: { modelPath: 'existing.stl' } });
    expect(useProjectStore.getState().hasContent).toBe(true);
    expect(usePlateSessionStore.getState().snapshot).toBe(modelSuccess.plateSession);
    expect(useSlicerStore.getState()).toMatchObject({ status: 'done', resultExported: true, error: expect.any(String) });
  });

  it('does not expose decoder diagnostics when DRC import fails', async () => {
    const { platform } = platformFor('broken.drc', { ok: false, error: 'Draco decoder detail' });
    await expect(addModel(platform, null)).resolves.toBe(false);
    expect(useSlicerStore.getState().error).toBe('Unable to import DRC file');
  });

  it.each(['broken.step', 'broken.stp'])('maps native %s failures to the generic STEP error', async (fileName) => {
    const { platform } = platformFor(fileName, { ok: false, error: 'OCCT diagnostic detail' });
    await expect(addModel(platform, null)).resolves.toBe(false);
    expect(useSlicerStore.getState().error).toBe('Unable to import STEP file');
  });

  it('routes externally dropped STL and STEP files through the shared runtime add path', async () => {
    const { platform, addModel: runtimeAdd } = platformFor('unused.stl', { ok: true });
    const onModelAdded = vi.fn();
    await addDroppedModels(platform, null, [
      { displayName: 'cube.stl', bytes: Uint8Array.from([1]) },
      { displayName: 'part.step', bytes: Uint8Array.from([2]) },
    ], undefined, onModelAdded);
    expect(runtimeAdd).toHaveBeenNthCalledWith(1, Uint8Array.from([1]), 'stl', 'cube.stl');
    expect(runtimeAdd).toHaveBeenNthCalledWith(2, Uint8Array.from([2]), 'step', 'part.step');
    expect(useProjectStore.getState().operation).toMatchObject({ phase: 'completed', progress: 100 });
    expect(onModelAdded).toHaveBeenCalledOnce();
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
      return modelSuccess;
    });
    const runProjectHistoryTransaction = vi.fn(async <T>(
      _label: string,
      _category: 'project',
      _before: unknown,
      mutation: (transactionId: string) => Promise<T>,
      _after: unknown | (() => unknown | Promise<unknown>),
    ) => ({ sceneDelta: null, result: await mutation('tx-1'), status: {} as never }));
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
    const onModelAdded = vi.fn();
    addModel.mockImplementation(async (_bytes: Uint8Array, _ext: string, name: string) => name === 'a.stl'
      ? modelSuccess
      : { ok: false, error: 'decoder detail' });
    await expect(addDroppedModels(platform, null, [
      { displayName: 'a.stl', bytes: Uint8Array.from([1]) },
      { displayName: 'b.stl', bytes: Uint8Array.from([2]) },
    ], undefined, onModelAdded)).resolves.toBe(true);
    expect(useProjectStore.getState().operation).toMatchObject({ phase: 'failed', progress: 50, cancellable: false });
    expect(useSlicerStore.getState().error).toBe('decoder detail');
    expect(onModelAdded).toHaveBeenCalledOnce();
  });

  it('returns false for a wholly failed dropped batch so navigation stays unchanged', async () => {
    const { platform } = platformFor('unused.stl', { ok: false, error: 'decoder detail' });
    const onModelAdded = vi.fn();
    await expect(addDroppedModels(platform, null, [
      { displayName: 'broken.stl', bytes: Uint8Array.from([1]) },
    ], undefined, onModelAdded)).resolves.toBe(false);
    expect(useProjectStore.getState().operation).toMatchObject({ phase: 'failed', progress: 0 });
    expect(onModelAdded).not.toHaveBeenCalled();
  });

  it('imports the bundled 3DBenchy resource through the normal model pipeline', async () => {
    const { platform, addModel: runtimeAdd } = platformFor('unused.stl', { ok: true });
    const onModelAdded = vi.fn();
    const fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([3, 13]).buffer,
    }));
    vi.stubGlobal('fetch', fetch);

    await addHandyModel(platform, null, HANDY_MODELS[4], onModelAdded);

    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/handy-models/3DBenchy.drc' }));
    expect(runtimeAdd).toHaveBeenCalledWith(Uint8Array.from([3, 13]), 'drc', '3DBenchy.drc');
    expect(useSettingsStore.getState()).toMatchObject({
      modelLoaded: true,
      values: { modelPath: '3DBenchy' },
    });
    expect(onModelAdded).toHaveBeenCalledOnce();
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
    let release!: (value: LoadModelResult) => void;
    const addShape = vi.fn(() => new Promise<LoadModelResult>((resolve) => { release = resolve; }));
    const runProjectHistoryTransaction = vi.fn(async (
      _label: string,
      _category: 'project',
      _before: unknown,
      mutation: (transactionId: string) => Promise<{ ok: boolean }>,
      _after: unknown,
    ) => ({ sceneDelta: null, result: await mutation('tx-1'), status: null }));
    const platform = {
      runtime: { addShape, runProjectHistoryTransaction },
    } as unknown as PlatformCapabilities;
    const onModelAdded = vi.fn();

    const pending = addPrimitive(platform, null, 'Cube', onModelAdded);
    await Promise.resolve();
    expect(useProjectStore.getState().projectMutationPendingCount).toBe(1);

    release(modelSuccess);
    await pending;
    expect(useProjectStore.getState().projectMutationPendingCount).toBe(0);
    expect(onModelAdded).toHaveBeenCalledOnce();
  });

  it('keeps Clear Scene fenced through its single filament refresh', async () => {
    const pendingAtRefresh: number[] = [];
    const platform = {
      runtime: {
        clearModel: vi.fn(async () => modelSuccess),
        runProjectHistoryTransaction: vi.fn(async (
          _label: string,
          _category: 'project',
          _before: unknown,
          mutation: (transactionId: string) => Promise<{ ok: boolean }>,
          _after: unknown,
        ) => ({ sceneDelta: null, result: await mutation('tx-1'), status: null })),
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
