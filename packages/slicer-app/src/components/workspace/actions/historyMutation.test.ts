import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryContext, HistoryStatus } from '@slicer/client';
import type { SlicerRuntime } from '@orca/platform-contract';
import { useObjectListStore } from '../objectList/useObjectListStore';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import { useFilamentSessionStore } from '../../../stores/useFilamentSessionStore';
import { useHistoryNavigationStore } from '../../../stores/useHistoryNavigationStore';
import { historyContextForStructure, projectHistoryStatus, runProjectHistoryMutation, syncHistoryStatus } from './historyMutation';
import { acquireProjectMutationLease } from '../../../history/projectMutationGate';

const status: HistoryStatus = {
  canUndo: true, canRedo: false, undoLabel: 'Delete', undoEntries: [], redoEntries: [],
  cursor: 1, savedCheckpoint: 0, savedCheckpointEvicted: false, dirty: true,
  bytesUsed: 1, byteBudget: 10, optionalBytesReleased: 0, evictedEntryCount: 0,
  lastEvictedEntryId: null, oldestRetainedEntryId: 'entry-0', oversizedEntryRetained: false,
  disabled: false, activeTransactionId: null, revision: 2,
};

type TransactionMock = ReturnType<typeof vi.fn> & SlicerRuntime['runProjectHistoryTransaction'];

function transactionRuntime() {
  const implementation = async <T>(
    _label: string,
    _category: 'project',
    before: HistoryContext,
    mutation: (id: string) => Promise<T>,
    after: HistoryContext | (() => HistoryContext | Promise<HistoryContext>),
  ): Promise<{ result: T; status: HistoryStatus }> => ({ result: await mutation('tx-1'), status: { ...status, revision: 3, undoLabel: before.activePlateId ?? 'mutation' } });
  const runProjectHistoryTransaction = vi.fn(implementation) as unknown as TransactionMock;
  const getFilamentSessionSnapshot = vi.fn(async () => ({
    ok: true, version: 1, slots: [], mappings: {}, flushing: {}, capabilities: {},
    assignments: { objects: [], parts: [], modifiers: [] },
    revisions: { session: 3, project: 3, result: 0, plates: {} }, status: { state: 'ready', error: null },
  } as never));
  return {
    runProjectHistoryTransaction,
    getHistoryStatus: vi.fn(async () => status),
    getFilamentSessionSnapshot,
    getModelStructure: vi.fn(async () => ({ ok: true as const, objects: [] })),
    getPlateSessionSnapshot: vi.fn(async () => ({
      ok: true as const,
      version: 1 as const,
      currentPlateId: 'plate-a',
      plates: [],
    })),
  };
}

describe('structural history transaction boundary', () => {
  beforeEach(() => {
    useObjectListStore.setState({
      structure: [{ id: 42, index: 0, name: 'Cube', printable: true, instanceCount: 1, volumes: [], instances: [] }],
      loaded: true,
      projection: { objectIds: new Set([42]), volumeIds: new Set(), instanceIds: new Set() },
    });
    usePlateSessionStore.getState().setSnapshot({
      ok: true, version: 1, currentPlateId: 'plate-a', plates: [{ plateId: 'plate-a', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1' }],
    });
    useProjectStore.getState().setProject({ dirty: false, dirtyReasons: [] });
    useHistoryNavigationStore.getState().reset();
  });

  it('captures stable object and plate IDs and commits one project transaction', async () => {
    const runtime = transactionRuntime();
    const before = historyContextForStructure();
    const response = await runProjectHistoryMutation(runtime, 'Delete Objects', async () => ({ ok: true, deleted: 1 }));

    expect(runtime.runProjectHistoryTransaction).toHaveBeenCalledOnce();
    expect(runtime.runProjectHistoryTransaction.mock.calls[0][2]).toEqual(expect.objectContaining({
      selection: expect.objectContaining({ objectIds: [42] }),
      activePlateId: 'plate-a',
    }));
    expect(before.selection.objectIds).toEqual([42]);
    expect(response.result).toEqual({ ok: true, deleted: 1 });
    expect(runtime.getHistoryStatus).not.toHaveBeenCalled();
  });

  it('returns a failed result after the transaction aborts', async () => {
    const runtime = transactionRuntime();
    const response = await runProjectHistoryMutation(runtime, 'Clear Scene', async () => ({ ok: false, error: 'rejected' }));
    expect(response.result).toEqual({ ok: false, error: 'rejected' });
  });

  it.each([false, true])('uses the Add Plate receipt without full reads (reflow=%s)', async (reflow) => {
    const runtime = transactionRuntime();
    let committed: HistoryContext | undefined;
    runtime.runProjectHistoryTransaction.mockImplementation(async (_label, _category, _before, mutation, after) => {
      const result = await mutation('tx-1');
      committed = typeof after === 'function' ? await after() : after;
      return { result, status };
    });
    await runProjectHistoryMutation(runtime, 'Add Plate', async () => ({
      ok: true, currentPlateId: 'plate-b', reflow,
    }), null, {
      contextReceipt: (result) => ({ structure: 'preserved', activePlateId: result.currentPlateId }),
    });
    expect(runtime.getModelStructure).not.toHaveBeenCalled();
    expect(runtime.getPlateSessionSnapshot).not.toHaveBeenCalled();
    expect(committed?.selection.objectIds).toEqual([42]);
    expect(committed?.activePlateId).toBe('plate-b');
  });

  it('projects structural deletion from an operation receipt before publication', async () => {
    const runtime = transactionRuntime();
    let committed: HistoryContext | undefined;
    runtime.runProjectHistoryTransaction.mockImplementation(async (_label, _category, _before, mutation, after) => {
      const result = await mutation('tx-1');
      committed = typeof after === 'function' ? await after() : after;
      return { result, status };
    });
    const publish = vi.fn(() => { expect(committed?.selection.objectIds).toEqual([]); });
    await runProjectHistoryMutation(runtime, 'Delete Objects', async () => ({ ok: true }), null, {
      contextReceipt: () => ({ structure: { ok: true, objects: [] }, activePlateId: 'plate-a' }),
      publish,
    });
    expect(runtime.getModelStructure).not.toHaveBeenCalled();
    expect(runtime.getPlateSessionSnapshot).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
  });

  it('does not consume a receipt or publish after a rejected operation', async () => {
    const runtime = transactionRuntime();
    const contextReceipt = vi.fn(() => ({ structure: 'preserved' as const, activePlateId: 'plate-b' }));
    const publish = vi.fn();
    const response = await runProjectHistoryMutation(runtime, 'Add Plate', async () => ({ ok: false, error: 'rejected' }), null, { contextReceipt, publish });
    expect(response.result.ok).toBe(false);
    expect(contextReceipt).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('projects the Worker checkpoint after an aborted transaction', async () => {
    const runtime = {
      runProjectHistoryTransaction: vi.fn(async () => { throw new Error('mutation failed'); }),
      getHistoryStatus: vi.fn(async () => ({ ...status, dirty: false, dirtyReasons: undefined })),
      getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false, error: 'unused' } as never)),
      getModelStructure: vi.fn(async () => ({ ok: true as const, objects: [] })),
      getPlateSessionSnapshot: vi.fn(async () => ({ ok: true as const, version: 1 as const, currentPlateId: 'plate-a', plates: [] })),
    };
    useProjectStore.getState().setProject({ dirty: true, dirtyReasons: ['model-transform'] });

    const response = await runProjectHistoryMutation(runtime, 'Clear Scene', async () => ({ ok: true }));

    expect(response.result).toEqual({ ok: false, error: 'mutation failed' });
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, dirtyReasons: [] });
  });

  it('filters deleted stable IDs and reads the authoritative active plate for after-context', async () => {
    const committed: { context?: HistoryContext } = {};
    const runtime = {
      runProjectHistoryTransaction: async <T>(
        _label: string,
        _category: 'project',
        _before: HistoryContext,
        mutation: (id: string) => Promise<T>,
        after: HistoryContext | (() => HistoryContext | Promise<HistoryContext>),
      ): Promise<{ result: T; status: HistoryStatus }> => {
        const result = await mutation('tx-1');
        committed.context = typeof after === 'function' ? await after() : after;
        return { result, status };
      },
      getModelStructure: async () => ({
        ok: true as const,
        objects: [{
          id: 43, index: 0, name: 'Survivor', printable: true, instanceCount: 1,
          volumes: [{ id: 430, index: 0, name: 'Part', type: 'model_part' as const, isSplittable: false }],
          instances: [{ id: 4300, index: 0, printable: true }],
        }],
      }),
      getPlateSessionSnapshot: async () => ({
        ok: true as const, version: 1 as const, currentPlateId: 'plate-b',
        plates: [{ plateId: 'plate-b', displayIndex: 0, origin: [0, 0, 0] as [number, number, number], name: 'Plate 2' }],
      }),
      getHistoryStatus: async () => status,
      getFilamentSessionSnapshot: async () => ({ ok: false, error: 'unused' } as never),
    };
    useObjectListStore.setState({
      structure: [{
        id: 42, index: 0, name: 'Deleted', printable: true, instanceCount: 1,
        volumes: [{ id: 420, index: 0, name: 'Part', type: 'model_part', isSplittable: false }],
        instances: [{ id: 4200, index: 0, printable: true }],
      }],
      projection: { objectIds: new Set([42]), volumeIds: new Set([420]), instanceIds: new Set([4200]) },
    });

    await runProjectHistoryMutation(runtime, 'Delete Objects', async () => ({ ok: true }));

    expect(committed.context?.selection).toEqual({ mode: 'part', objectIds: [], partIds: [], instanceIds: [] });
    expect(committed.context?.activePlateId).toBe('plate-b');
  });

  it('projects Worker dirty state after a plate or configuration mutation', async () => {
    const runtime = transactionRuntime();
    await syncHistoryStatus(runtime);
    expect(useProjectStore.getState().dirty).toBe(true);
    expect(useProjectStore.getState().dirtyReasons).toEqual([]);
  });

  it('does not let a delayed older status overwrite an atomic move checkpoint', () => {
    const current = { ...status, revision: 7, undoLabel: 'Move Prime Tower' };
    useHistoryNavigationStore.getState().setStatus(current);
    expect(projectHistoryStatus({ ...status, revision: 6, undoLabel: 'Undo' })).toBe(current);
    expect(useHistoryNavigationStore.getState().status).toBe(current);
  });

  it('orders an older status read before a queued mutation', async () => {
    let releaseStatus!: (value: HistoryStatus) => void;
    const oldStatus = { ...status, dirty: false, revision: 1 };
    const newStatus = {
      ...status,
      dirty: true,
      revision: 2,
      undoEntries: [{ id: 'add-cube', label: 'Add Cube', category: 'project' as const }],
    };
    const runtime = transactionRuntime();
    runtime.getHistoryStatus.mockImplementationOnce(() => new Promise<HistoryStatus>((resolve) => {
      releaseStatus = resolve;
    }));
    runtime.runProjectHistoryTransaction.mockImplementationOnce(async <T>(
      _label: string,
      _category: 'project',
      _before: HistoryContext,
      mutation: (id: string) => Promise<T>,
    ) => ({ result: await mutation('tx-1'), status: newStatus }));

    const read = syncHistoryStatus(runtime);
    const mutation = runProjectHistoryMutation(runtime, 'Add Cube', async () => ({ ok: true }));
    await Promise.resolve();
    expect(runtime.runProjectHistoryTransaction).not.toHaveBeenCalled();

    releaseStatus(oldStatus);
    await read;
    expect(useHistoryNavigationStore.getState().status).toEqual(oldStatus);
    await mutation;
    expect(useHistoryNavigationStore.getState().status).toEqual(newStatus);
    expect(useProjectStore.getState().dirty).toBe(true);
    expect(runtime.getHistoryStatus).toHaveBeenCalledOnce();
  });

  it('keeps its owned project fence through the filament refresh on success and failure', async () => {
    const success = transactionRuntime();
    const successPending: number[] = [];
    success.getFilamentSessionSnapshot.mockImplementation(async () => {
      successPending.push(useProjectStore.getState().projectMutationPendingCount);
      return { ok: true, version: 1, slots: [], mappings: {}, flushing: {}, capabilities: {},
        assignments: { objects: [], parts: [], modifiers: [] },
        revisions: { session: 3, project: 3, result: 0, plates: {} }, status: { state: 'ready', error: null } } as never;
    });
    await runProjectHistoryMutation(success, 'Rename Object', async () => ({ ok: true }));
    expect(successPending).toEqual([1]);
    expect(useProjectStore.getState().projectMutationPendingCount).toBe(0);

    useProjectStore.getState().reset();
    const failurePending: number[] = [];
    const failure = {
      runProjectHistoryTransaction: vi.fn(async () => { throw new Error('mutation failed'); }),
      getHistoryStatus: vi.fn(async () => status),
      getFilamentSessionSnapshot: vi.fn(async () => {
        failurePending.push(useProjectStore.getState().projectMutationPendingCount);
        return { ok: true, version: 1, slots: [], mappings: {}, flushing: {}, capabilities: {},
          assignments: { objects: [], parts: [], modifiers: [] },
          revisions: { session: 4, project: 4, result: 0, plates: {} }, status: { state: 'ready', error: null } } as never;
      }),
      getModelStructure: vi.fn(async () => ({ ok: true as const, objects: [] })),
      getPlateSessionSnapshot: vi.fn(async () => ({ ok: true as const, version: 1 as const, currentPlateId: 'plate-a', plates: [] })),
    };
    await runProjectHistoryMutation(failure, 'Rename Object', async () => ({ ok: true }));
    expect(failurePending).toEqual([1]);
    expect(useProjectStore.getState().projectMutationPendingCount).toBe(0);
  });

  it('nests its own lease while a caller retains an outer lease', async () => {
    const runtime = transactionRuntime();
    const pending: number[] = [];
    runtime.getFilamentSessionSnapshot.mockImplementation(async () => {
      pending.push(useProjectStore.getState().projectMutationPendingCount);
      return { ok: true, version: 1, slots: [], mappings: {}, flushing: {}, capabilities: {},
        assignments: { objects: [], parts: [], modifiers: [] },
        revisions: { session: 3, project: 3, result: 0, plates: {} }, status: { state: 'ready', error: null } } as never;
    });
    const lease = acquireProjectMutationLease();
    await runProjectHistoryMutation(runtime, 'Clear Scene', async () => ({ ok: true }), null,
    );
    expect(pending).toEqual([2]);
    expect(useProjectStore.getState().projectMutationPendingCount).toBe(1);
    lease.release();
  });

  it('serializes overlapping project transactions and refreshes each revision in order', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started: string[] = [];
    const runtime = transactionRuntime();
    runtime.runProjectHistoryTransaction.mockImplementation(async <T>(label: string, _category: 'project', before: HistoryContext, mutation: (id: string) => Promise<T>) => {
      started.push(label);
      if (label === 'First') await firstGate;
      return { result: await mutation('tx-1'), status: { ...status, revision: label === 'First' ? 3 : 4, undoLabel: before.activePlateId ?? label } };
    });
    const first = runProjectHistoryMutation(runtime, 'First', async () => ({ ok: true }));
    const second = runProjectHistoryMutation(runtime, 'Second', async () => ({ ok: true }));
    await Promise.resolve();
    expect(started).toEqual(['First']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(started).toEqual(['First', 'Second']);
    expect(runtime.getFilamentSessionSnapshot).toHaveBeenCalledTimes(2);
    expect(useProjectStore.getState().projectMutationPendingCount).toBe(0);
  });

  it('queues a filament mutation behind a pending project transaction without stale rejection', async () => {
    let releaseProject!: () => void;
    const projectGate = new Promise<void>((resolve) => { releaseProject = resolve; });
    const runtime = transactionRuntime();
    runtime.runProjectHistoryTransaction.mockImplementation(async <T>(
      _label: string,
      _category: 'project',
      _before: HistoryContext,
      mutation: (id: string) => Promise<T>,
    ) => {
      const result = await mutation('tx-1');
      await projectGate;
      return { result, status };
    });
    const project = runProjectHistoryMutation(runtime, 'Add Cube', async () => ({ ok: true }));
    const command = vi.fn(async () => ({
      ok: true as const,
      version: 1 as const,
      result: {
        snapshot: {
          ok: true as const,
          version: 1 as const,
          slots: [], mappings: {}, flushing: {}, capabilities: {},
          assignments: { objects: [], parts: [], modifiers: [] },
          revisions: { session: 4, project: 4, result: 0, plates: {} },
          status: { state: 'ready' as const, error: null },
        },
        mutation: {
          kind: 'assign' as const, historyEntryDelta: 1 as const,
          revisionBefore: 3, revisionAfter: 4, dirty: true as const,
          allPlateResultsInvalidated: false as const,
        },
        historyStatus: { ...status, revision: 4, canUndo: true, canRedo: false, redoEntries: [], dirty: true },
      },
    } as never));
    const filament = useFilamentSessionStore.getState().run(runtime as never, command);

    await Promise.resolve();
    expect(command).not.toHaveBeenCalled();
    releaseProject();
    await Promise.all([project, filament]);
    expect(command).toHaveBeenCalledOnce();
    expect(useFilamentSessionStore.getState().rejected).toBeNull();
    expect(useHistoryNavigationStore.getState().status).toMatchObject({ revision: 4, canRedo: false, dirty: true });
    // A delayed pre-branch status must not re-enable Redo after the receipt
    // from the same FIFO mutation has truncated that branch.
    projectHistoryStatus({ ...status, revision: 3, canRedo: true, redoEntries: [{ id: 'redo-1', label: 'Undo Add Cube', category: 'project' }] });
    expect(useHistoryNavigationStore.getState().status).toMatchObject({ revision: 4, canRedo: false });
  });
});
