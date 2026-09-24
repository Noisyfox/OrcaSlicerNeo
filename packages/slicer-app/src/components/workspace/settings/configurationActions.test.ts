import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformCapabilities } from '@orca/platform-contract';
import type { HistoryStatus, PresetDraftMutationRequest, PresetDraftMutationResult } from '@slicer/client';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { useFilamentSessionStore } from '../../../stores/useFilamentSessionStore';
import { useHistoryNavigationStore } from '../../../stores/useHistoryNavigationStore';
import { commitOptionFieldChange } from './OptionField';
import {
  commitScopedConfigurationMutation,
  commitPresetDraftMutation,
  commitSharedConfigurationMutation,
  invalidateAfterSharedConfigurationMutation,
  waitForConfigurationMutations,
} from './configurationActions';

function affected(scope: 'project' | 'object' | 'part' | 'plate', values: Record<string, string>, id?: string) {
  return { version: 1 as const, revision: 1, kind: 'affected' as const,
    replacements: [{ scope, ...(scope === 'project' ? {} : { id: id ?? '42' }), values }], removedTargets: [] as const };
}
const baseline = {
  version: 1 as const, revision: 0, kind: 'full' as const,
  snapshot: { project: {}, objects: { '42': {} }, parts: {}, plates: { 'plate-1': {} } },
  removedTargets: [] as const,
};

const mutation = {
  instances: [],
  ok: true as const,
  version: 1 as const,
  currentPlateId: 'plate-1',
  plates: [{ plateId: 'plate-1', displayIndex: 0, origin: [0, 0, 0] as [number, number, number], name: 'Plate 1' }],
  instanceTransforms: [],
  inputRevisions: { 'plate-1': 9 },
  affectedPlateIdsBefore: ['plate-1'],
  affectedPlateIdsAfter: ['plate-1'],
  affectedPlateIds: ['plate-1'],
  dirtyReasons: ['shared-configuration'],
};

function runProjectHistoryTransaction<T>(
  _label: string,
  _category: 'project',
  _before: unknown,
  mutationCallback: (transactionId: string) => Promise<T>,
  _after: unknown | (() => unknown | Promise<unknown>),
): Promise<{ result: T; status: { revision: number; nativeScopedConfig?: unknown } }> {
  return mutationCallback('tx-1').then((result) => ({ sceneDelta: null, result, status: {
    revision: 1,
    nativeScopedConfig: (result as unknown as { nativeScopedConfig?: unknown }).nativeScopedConfig,
  } }));
}

const historyProjectionRuntime = {
  getHistoryStatus: vi.fn(async () => ({ dirty: false } as never)),
  getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false, error: 'unused' } as never)),
};

function presetHistoryStatus(revision: number): HistoryStatus {
  return {
    canUndo: true, canRedo: false, undoLabel: 'Edit Preset', undoEntries: [], redoEntries: [],
    cursor: revision, savedCheckpoint: 0, savedCheckpointEvicted: false, dirty: true,
    bytesUsed: 10, byteBudget: 1024, evictedEntryCount: 0, lastEvictedEntryId: null,
    oldestRetainedEntryId: null, oversizedEntryRetained: false, disabled: false,
    activeTransactionId: null, revision,
  };
}

function presetReceipt(allPlateResultsInvalidated: true): Extract<PresetDraftMutationResult, { ok: true }> {
  return {
    ok: true, version: 1, kind: 'printer', canonicalName: 'Printer A', draftExists: true,
    modified: true, overrides: { printable_height: '250' },
    sourceValues: { printable_height: '230' }, effectiveValues: { printable_height: '250' },
    optionMetadata: {}, revision: 2,
    historyEntryDelta: 1, revisionBefore: 1, revisionAfter: 2, dirty: true,
    affectedPlateIds: ['plate-1', 'plate-2'], allPlateResultsInvalidated,
    plateSession: { ...mutation,
      plates: [
        { plateId: 'plate-1', displayIndex: 0, origin: [0, 0, 0] as [number, number, number], name: 'Plate 1' },
        { plateId: 'plate-2', displayIndex: 1, origin: [264, 0, 0] as [number, number, number], name: 'Plate 2' },
      ],
      currentPlateId: 'plate-1', inputRevisions: { 'plate-1': 12, 'plate-2': 18 },
      affectedPlateIdsBefore: ['plate-1', 'plate-2'], affectedPlateIdsAfter: ['plate-1', 'plate-2'],
    },
    historyStatus: presetHistoryStatus(2),
    filamentSession: { revisions: { session: 2, project: 2, plates: { 'plate-1': 12, 'plate-2': 18 } },
      flushing: { matrix: [0, 140, 160, 0] } },
    nativeScopedConfig: {
      version: 1, revision: 1, kind: 'full',
      snapshot: { project: { printable_height: '250' }, objects: {}, parts: {}, plates: {} },
      removedTargets: [],
    },
  } as unknown as Extract<PresetDraftMutationResult, { ok: true }>;
}

describe('commitSharedConfigurationMutation', () => {
  beforeEach(() => {
    useProjectStore.getState().reset();
    useSlicerStore.getState().clearPlateResults();
    useSlicerStore.setState({ error: null });
    useSettingsStore.getState().resetNativeScopedConfig();
    useSettingsStore.getState().applyNativeScopedConfigTransport(baseline);
  });

  it('routes an option-field commit through the typed runtime before recording it', async () => {
    const mark = vi.fn(async () => mutation);
    const setNativeScopedConfig = vi.fn(async () => ({
      ok: true as const,
      nativeScopedConfig: affected('project', { layer_height: '0.3' }),
      plateSession: mutation,
    }));
    const platform = { runtime: { ...historyProjectionRuntime, markSharedConfigurationMutation: mark, setNativeScopedConfig, runProjectHistoryTransaction } } as unknown as PlatformCapabilities;
    await commitOptionFieldChange(platform, 'layer_height', '0.3');
    expect(setNativeScopedConfig).toHaveBeenCalledWith({ scope: 'project' }, 'layer_height', '0.3');
    expect(mark).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().values.layer_height).toBe('0.3');
    expect(useProjectStore.getState().plateInputRevisions).toEqual({ 'plate-1': 9 });
  });

  it('records the authoritative runtime transaction, including its revisions', async () => {
    const mark = vi.fn(async () => mutation);
    const platform = { runtime: { ...historyProjectionRuntime, markSharedConfigurationMutation: mark, setNativeScopedConfig: vi.fn(), runProjectHistoryTransaction } } as unknown as PlatformCapabilities;
    await expect(commitSharedConfigurationMutation(platform)).resolves.toBe(mutation);
    expect(mark).toHaveBeenCalledOnce();
    expect(useProjectStore.getState()).toMatchObject({
      dirty: true,
      dirtyReasons: ['shared-configuration'],
      plateInputRevisions: { 'plate-1': 9 },
    });
  });

  it('surfaces a rejected bridge transaction without dirtying the store', async () => {
    const mark = vi.fn(async () => ({ ok: false as const, error: 'bridge rejected' }));
    const platform = { runtime: { ...historyProjectionRuntime, markSharedConfigurationMutation: mark, setNativeScopedConfig: vi.fn(), runProjectHistoryTransaction } } as unknown as PlatformCapabilities;
    await expect(commitSharedConfigurationMutation(platform)).rejects.toThrow('bridge rejected');
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, dirtyReasons: [], plateInputRevisions: {} });
    expect(useSlicerStore.getState().error).toBe('bridge rejected');
  });

  it('keeps the native effective correction for a project setting', async () => {
    const setNativeScopedConfig = vi.fn(async () => ({
      ok: true as const,
      nativeScopedConfig: affected('project', { prime_tower_width: '20' }),
      configurationStatus: { state: 'ready' as const, corrections: [{ key: 'prime_tower_width', requested: 'invalid', effective: '20' }], warnings: [], errors: [] },
      plateSession: mutation,
    }));
    const platform = { runtime: { ...historyProjectionRuntime, setNativeScopedConfig, runProjectHistoryTransaction } } as unknown as PlatformCapabilities;
    await commitOptionFieldChange(platform, 'prime_tower_width', 'invalid');
    expect(setNativeScopedConfig).toHaveBeenCalledWith({ scope: 'project' }, 'prime_tower_width', 'invalid');
    expect(useSettingsStore.getState().nativeScopedConfig.project.prime_tower_width).toBe('20');
    expect(useProjectStore.getState().plateInputRevisions).toEqual({ 'plate-1': 9 });
  });

  it('invalidates only the native affected plate for a scoped model override', async () => {
    const slicer = useSlicerStore.getState();
    slicer.setPlateResult({ plateId: 'plate-1', inputStamp: 1, resultGeneration: '1', sliceTaskId: '1' });
    slicer.setPlateResult({ plateId: 'plate-2', inputStamp: 1, resultGeneration: '1', sliceTaskId: '2' });
    const setNativeScopedConfig = vi.fn(async () => ({
      ok: true as const,
      nativeScopedConfig: affected('object', { layer_height: '0.15' }, '42'),
      plateSession: { ...mutation, inputRevisions: { 'plate-1': 9 }, affectedPlateIds: ['plate-1'] },
    }));
    const platform = { runtime: { ...historyProjectionRuntime, setNativeScopedConfig, runProjectHistoryTransaction } } as unknown as PlatformCapabilities;
    await commitOptionFieldChange(platform, 'layer_height', '0.15', { scope: 'object', id: 42 });
    expect(Object.keys(useSlicerStore.getState().plateResults)).toEqual(['plate-2']);
  });

  it('treats an explicit empty native affected set as a scoped no-op', () => {
    const slicer = useSlicerStore.getState();
    slicer.setPlateResult({ plateId: 'plate-1', inputStamp: 1, resultGeneration: '1', sliceTaskId: '1' });
    slicer.setPlateResult({ plateId: 'plate-2', inputStamp: 1, resultGeneration: '1', sliceTaskId: '2' });
    useSlicerStore.setState({ error: 'existing status' });
    const runtime = {
      cancel: vi.fn(async () => undefined),
      getRuntimeExecutionState: vi.fn(() => ({ threaded: true })),
    } as unknown as Pick<import('@slicer/client').SlicerClient, 'cancel' | 'getRuntimeExecutionState'>;

    invalidateAfterSharedConfigurationMutation([], runtime);

    expect(Object.keys(useSlicerStore.getState().plateResults)).toEqual(['plate-1', 'plate-2']);
    expect(useSlicerStore.getState().error).toBe('existing status');
    expect(runtime.cancel).not.toHaveBeenCalled();
  });

  it('invalidates every plate listed by a complete shared transition receipt', () => {
    const slicer = useSlicerStore.getState();
    slicer.setPlateResult({ plateId: 'plate-1', inputStamp: 1, resultGeneration: '1', sliceTaskId: '1' });
    slicer.setPlateResult({ plateId: 'plate-2', inputStamp: 1, resultGeneration: '1', sliceTaskId: '2' });

    invalidateAfterSharedConfigurationMutation(['plate-1', 'plate-2'], undefined, true);

    expect(Object.keys(useSlicerStore.getState().plateResults)).toEqual([]);
  });

  it('publishes native warnings without converting a successful commit into a failure', async () => {
    const setNativeScopedConfig = vi.fn()
      .mockResolvedValueOnce({
        ok: true as const,
        nativeScopedConfig: affected('project', { prime_tower_width: '20' }),
        configurationStatus: { state: 'ready' as const, corrections: [], warnings: ['width was clamped'], errors: [] },
        plateSession: mutation,
      })
      .mockResolvedValueOnce({
        ok: true as const,
        nativeScopedConfig: { ...affected('project', { prime_tower_width: '21' }), revision: 2 },
        configurationStatus: { state: 'ready' as const, corrections: [], warnings: [], errors: [] },
        plateSession: mutation,
      });
    const platform = { runtime: { setNativeScopedConfig, runProjectHistoryTransaction } } as unknown as PlatformCapabilities;

    await expect(commitOptionFieldChange(platform, 'prime_tower_width', '20')).resolves.toBeUndefined();
    expect(useSettingsStore.getState().nativeScopedConfig.project.prime_tower_width).toBe('20');
    expect(useProjectStore.getState().dirty).toBe(true);
    expect(useSlicerStore.getState().error).toBe('[Warning] width was clamped');

    await commitOptionFieldChange(platform, 'prime_tower_width', '21');
    expect(useSettingsStore.getState().nativeScopedConfig.project.prime_tower_width).toBe('21');
    expect(useSlicerStore.getState().error).toBe('[Warning] width was clamped');
  });

  it('keeps a multi-target reset inside one native history transaction', async () => {
    const mutateNativeScopedConfig = vi.fn(async () => ({
      ok: true as const,
      nativeScopedConfig: affected('object', {}, '42'),
      plateSession: mutation,
    }));
    const platform = { runtime: {
      ...historyProjectionRuntime, mutateNativeScopedConfig, runProjectHistoryTransaction,
    } } as unknown as PlatformCapabilities;
    await commitScopedConfigurationMutation(platform, {
      version: 1,
      operation: 'reset',
      targets: [{ scope: 'object', id: 42 }, { scope: 'object', id: 43 }],
      key: 'layer_height',
    });
    expect(mutateNativeScopedConfig).toHaveBeenCalledOnce();
    expect(mutateNativeScopedConfig).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'reset', targets: [{ scope: 'object', id: 42 }, { scope: 'object', id: 43 }],
    }));
  });

  it('routes a Project-mode set only to the native Project target', async () => {
    const mutateNativeScopedConfig = vi.fn(async () => ({
      ok: true as const,
      nativeScopedConfig: affected('project', { layer_height: '0.3' }),
      plateSession: mutation,
    }));
    const platform = { runtime: {
      ...historyProjectionRuntime, mutateNativeScopedConfig, runProjectHistoryTransaction,
    } } as unknown as PlatformCapabilities;
    await commitScopedConfigurationMutation(platform, {
      version: 1,
      operation: 'set',
      targets: [{ scope: 'project' }],
      key: 'layer_height',
      value: '0.3',
    });
    expect(mutateNativeScopedConfig).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'set', targets: [{ scope: 'project' }], key: 'layer_height', value: '0.3',
    }));
  });

  it('keeps the configuration queue pending until a deferred scoped commit settles', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mutateNativeScopedConfig = vi.fn(async () => {
      await gate;
      return {
        ok: true as const,
        nativeScopedConfig: affected('project', { layer_height: '0.3' }),
        plateSession: mutation,
      };
    });
    const platform = { runtime: {
      ...historyProjectionRuntime, mutateNativeScopedConfig, runProjectHistoryTransaction,
    } } as unknown as PlatformCapabilities;
    const commit = commitScopedConfigurationMutation(platform, {
      version: 1,
      operation: 'set',
      targets: [{ scope: 'project' }],
      key: 'layer_height',
      value: '0.3',
    });
    await vi.waitFor(() => expect(mutateNativeScopedConfig).toHaveBeenCalledOnce());
    let settled = false;
    const waiter = waitForConfigurationMutations().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await commit;
    await waiter;
    expect(settled).toBe(true);
  });
  it.each(['shared', 'scoped'])('accepts a %s no-op without invalidating results or refreshing configuration', async (path) => {
    const noOp = vi.fn(async () => ({ ok: true as const, nativeScopedConfig: {
      ...affected('project', {}), revision: 0,
    } }));
    const invalidate = vi.spyOn(useSlicerStore.getState(), 'invalidatePlateResults');
    const refresh = vi.fn();
    const platform = { runtime: { ...historyProjectionRuntime, setNativeScopedConfig: noOp,
      mutateNativeScopedConfig: noOp, getNativeScopedConfig: refresh, runProjectHistoryTransaction,
    } } as unknown as PlatformCapabilities;
    try {
      if (path === 'shared') await commitOptionFieldChange(platform, 'layer_height', '0.2');
      else await expect(commitScopedConfigurationMutation(platform, { version: 1, operation: 'set',
        targets: [{ scope: 'project' }], key: 'layer_height', value: '0.2' })).resolves.toBeNull();
      expect(noOp).toHaveBeenCalledOnce();
      expect(invalidate).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(useProjectStore.getState().dirtyReasons).toEqual([]);
      expect(useSlicerStore.getState().error).toBeNull();
    } finally { invalidate.mockRestore(); }
  });

});

describe('commitPresetDraftMutation', () => {
  const request: PresetDraftMutationRequest = {
    kind: 'printer', canonicalName: 'Printer A', expectedRevision: 1,
    action: 'set', key: 'printable_height', value: '250',
  };

  beforeEach(() => {
    useProjectStore.getState().reset();
    usePlateSessionStore.getState().reset();
    useFilamentSessionStore.getState().reset();
    useHistoryNavigationStore.getState().reset();
    useSlicerStore.getState().clearPlateResults();
    useSlicerStore.setState({ status: 'idle', error: null });
    useSettingsStore.getState().resetNativeScopedConfig();
  });

  it('publishes one native success receipt and honors its all-results invalidation flag', async () => {
    const receipt = presetReceipt(true);
    const mutatePresetDraft = vi.fn(async () => receipt);
    const runProjectHistoryTransaction = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const runtime = {
      ...historyProjectionRuntime,
      mutatePresetDraft,
      runProjectHistoryTransaction,
      cancel,
      getRuntimeExecutionState: vi.fn(() => ({ threaded: true })),
    };
    const platform = { runtime } as unknown as PlatformCapabilities;
    for (const plateId of ['plate-1', 'plate-2', 'unaffected-plate'])
      useSlicerStore.getState().setPlateResult({ plateId, inputStamp: 1, resultGeneration: plateId, sliceTaskId: plateId } as never);
    useSlicerStore.getState().setActiveSliceTarget({ plateId: 'plate-1', inputRevision: 1 });
    useFilamentSessionStore.setState({ snapshot: { revisions: { session: 1, project: 1, plates: {} } } as never });

    await expect(commitPresetDraftMutation(platform, request)).resolves.toBe(receipt);

    expect(mutatePresetDraft).toHaveBeenCalledOnce();
    expect(mutatePresetDraft).toHaveBeenCalledWith(request);
    expect(runProjectHistoryTransaction).not.toHaveBeenCalled();
    expect(useHistoryNavigationStore.getState().status).toBe(receipt.historyStatus);
    expect(useProjectStore.getState()).toMatchObject({ dirty: true, plateInputRevisions: { 'plate-1': 12, 'plate-2': 18 } });
    expect(usePlateSessionStore.getState().snapshot).toBe(receipt.plateSession);
    expect(useFilamentSessionStore.getState().snapshot).toBe(receipt.filamentSession);
    expect(useSettingsStore.getState().nativeScopedConfig.project.printable_height).toBe('250');
    expect(Object.keys(useSlicerStore.getState().plateResults)).toEqual([]);
    expect(useSlicerStore.getState().activeSliceTarget).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('returns a native stale rejection without publishing history, project, session, config, or slice corrections', async () => {
    const stale = { ok: false as const, version: 1 as const, errorCode: 'stale_revision', error: 'draft revision is stale' };
    const mutatePresetDraft = vi.fn(async () => stale);
    const runProjectHistoryTransaction = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const runtime = {
      ...historyProjectionRuntime,
      mutatePresetDraft,
      runProjectHistoryTransaction,
      cancel,
      getRuntimeExecutionState: vi.fn(() => ({ threaded: true })),
    };
    const platform = { runtime } as unknown as PlatformCapabilities;
    const initialHistory = presetHistoryStatus(1);
    useHistoryNavigationStore.getState().setStatus(initialHistory);
    usePlateSessionStore.getState().setSnapshot(mutation as never);
    useSlicerStore.getState().setPlateResult({ plateId: 'plate-1', inputStamp: 1, resultGeneration: 'before', sliceTaskId: 'before' } as never);
    useSlicerStore.getState().setActiveSliceTarget({ plateId: 'plate-1', inputRevision: 1 });
    useSlicerStore.getState().setError('existing message');

    await expect(commitPresetDraftMutation(platform, request)).resolves.toBe(stale);

    expect(mutatePresetDraft).toHaveBeenCalledOnce();
    expect(runProjectHistoryTransaction).not.toHaveBeenCalled();
    expect(useHistoryNavigationStore.getState().status).toBe(initialHistory);
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, plateInputRevisions: {} });
    expect(usePlateSessionStore.getState().snapshot).toBe(mutation);
    expect(useSettingsStore.getState().nativeScopedConfigRevision).toBeNull();
    expect(Object.keys(useSlicerStore.getState().plateResults)).toEqual(['plate-1']);
    expect(useSlicerStore.getState().activeSliceTarget).toEqual({ plateId: 'plate-1', inputRevision: 1 });
    expect(useSlicerStore.getState().error).toBe('existing message');
    expect(cancel).not.toHaveBeenCalled();
  });
});
