import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryContext, HistoryStatus } from '@slicer/client';
import { useObjectListStore } from '../objectList/useObjectListStore';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import { historyContextForStructure, runProjectHistoryMutation, syncHistoryStatus } from './historyMutation';

const status: HistoryStatus = {
  canUndo: true, canRedo: false, undoLabel: 'Delete', undoEntries: [], redoEntries: [],
  cursor: 1, savedCheckpoint: 0, savedCheckpointEvicted: false, dirty: true,
  bytesUsed: 1, byteBudget: 10, disabled: false, activeTransactionId: null, revision: 2,
};

function transactionRuntime() {
  const runProjectHistoryTransaction = vi.fn(async <T>(
    _label: string,
    _category: 'project' | 'context',
    before: HistoryContext,
    mutation: (id: string) => Promise<T>,
    after: HistoryContext | (() => HistoryContext),
  ) => ({ result: await mutation('tx-1'), status: { ...status, revision: 3, undoLabel: before.activePlateId ?? 'mutation' }, context: after }));
  return { runProjectHistoryTransaction, getHistoryStatus: vi.fn(async () => status) };
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
  });

  it('captures stable object and plate IDs and commits one project transaction', async () => {
    const runtime = transactionRuntime();
    const before = historyContextForStructure();
    const response = await runProjectHistoryMutation(runtime as never, 'Delete Objects', async () => ({ ok: true, deleted: 1 }));

    expect(runtime.runProjectHistoryTransaction).toHaveBeenCalledOnce();
    expect(runtime.runProjectHistoryTransaction.mock.calls[0][2]).toEqual(expect.objectContaining({
      selection: expect.objectContaining({ objectIds: [42] }),
      activePlateId: 'plate-a',
    }));
    expect(before.selection.objectIds).toEqual([42]);
    expect(response.result).toEqual({ ok: true, deleted: 1 });
  });

  it('returns a failed result after the transaction aborts', async () => {
    const runtime = transactionRuntime();
    const response = await runProjectHistoryMutation(runtime as never, 'Clear Scene', async () => ({ ok: false, error: 'rejected' }));
    expect(response.result).toEqual({ ok: false, error: 'rejected' });
  });

  it('filters deleted stable IDs and reads the authoritative active plate for after-context', async () => {
    const committed: { context?: HistoryContext } = {};
    const runtime = {
      runProjectHistoryTransaction: async (
        _label: string,
        _category: 'project',
        _before: HistoryContext,
        mutation: (id: string) => Promise<{ ok: boolean }>,
        after: HistoryContext | (() => HistoryContext | Promise<HistoryContext>),
      ) => {
        const result = await mutation('tx-1');
        committed.context = typeof after === 'function' ? await after() : after;
        return { result, status };
      },
      getModelStructure: async () => ({
        ok: true,
        objects: [{
          id: 43, index: 0, name: 'Survivor', printable: true, instanceCount: 1,
          volumes: [{ id: 430, index: 0, name: 'Part', type: 'model_part', isSplittable: false }],
          instances: [{ id: 4300, index: 0, printable: true }],
        }],
      }),
      getPlateSessionSnapshot: async () => ({
        ok: true, version: 2, currentPlateId: 'plate-b',
        plates: [{ plateId: 'plate-b', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 2' }],
      }),
    };
    useObjectListStore.setState({
      structure: [{
        id: 42, index: 0, name: 'Deleted', printable: true, instanceCount: 1,
        volumes: [{ id: 420, index: 0, name: 'Part', type: 'model_part', isSplittable: false }],
        instances: [{ id: 4200, index: 0, printable: true }],
      }],
      projection: { objectIds: new Set([42]), volumeIds: new Set([420]), instanceIds: new Set([4200]) },
    });

    await runProjectHistoryMutation(runtime as never, 'Delete Objects', async () => ({ ok: true }));

    expect(committed.context?.selection).toEqual({ mode: 'part', objectIds: [], partIds: [], instanceIds: [] });
    expect(committed.context?.activePlateId).toBe('plate-b');
  });

  it('projects Worker dirty state after a plate or configuration mutation', async () => {
    const runtime = transactionRuntime();
    await syncHistoryStatus(runtime);
    expect(useProjectStore.getState().dirty).toBe(true);
    expect(useProjectStore.getState().dirtyReasons).toEqual([]);
  });
});
