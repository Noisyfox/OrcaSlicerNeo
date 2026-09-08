import { describe, expect, it } from 'vitest';
import { createClient } from './client';
import { createMockModule } from './testing/mock-module';
import { createWorkerClient, startWorker, type WorkerMessage, type WorkerTransport } from './worker';
import type { HistoryContext } from './history';

const context = (activePlateId: string | null = null): HistoryContext => ({
  selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId, gizmo: null, projectConfigOverlay: {},
});

class Channel implements WorkerTransport {
  private listeners: Array<(message: WorkerMessage) => void> = [];
  onMessage(fn: (message: WorkerMessage) => void): void { this.listeners.push(fn); }
  post(message: WorkerMessage): void { for (const listener of this.listeners) listener(message); }
}

describe('Worker-owned project history protocol', () => {
  it('commits a controlled mutation and restores it through undo/redo and jump', async () => {
    const client = createClient(async () => createMockModule());
    const before = context('plate-session-1-plate-1');
    const transaction = await client.beginHistory('Add Cube', 'project', before);
    await client.addShape('Cube');
    const after = context('plate-session-1-plate-1');
    const status = await client.commitHistory(transaction, after);
    expect(status.canUndo).toBe(true);
    expect((await client.getModelStructure()).objects).toHaveLength(1);
    const undone = await client.undoHistory();
    expect(undone.ok).toBe(true);
    expect((await client.getModelStructure()).objects).toHaveLength(0);
    const redone = await client.redoHistory();
    expect(redone.ok).toBe(true);
    expect((await client.getModelStructure()).objects).toHaveLength(1);
    if (!redone.ok || !redone.entryId) throw new Error('missing entry id');
    expect((await client.jumpHistory(redone.entryId, 'undo')).ok).toBe(true);
    expect((await client.getModelStructure()).objects).toHaveLength(0);
    expect((await client.jumpHistory(redone.entryId, 'redo')).ok).toBe(true);
    expect((await client.getModelStructure()).objects).toHaveLength(1);
  });

  it('uses directional targets for menu jumps and rejects stale/opposite entries', async () => {
    const client = createClient(async () => createMockModule());
    const baseline = context('plate-1');
    const first = await client.runProjectHistoryTransaction('First', 'project', baseline,
      async () => client.addShape('Cube'), baseline);
    const firstId = first.status.undoEntries[0]?.id;
    if (!firstId) throw new Error('missing first entry id');
    await client.recordHistoryContext('Selection', context('plate-2'));
    const second = await client.runProjectHistoryTransaction('Second', 'project', context('plate-2'),
      async () => client.addShape('Cube'), context('plate-2'));
    const secondId = second.status.undoEntries[0]?.id;
    if (!secondId) throw new Error('missing second entry id');

    const topUndo = await client.jumpHistory(secondId, 'undo');
    expect(topUndo.ok).toBe(true);
    expect((await client.getModelStructure()).objects).toHaveLength(1);
    const olderUndo = await client.jumpHistory(firstId, 'undo');
    expect(olderUndo.ok).toBe(true);
    expect((await client.getModelStructure()).objects).toHaveLength(0);
    const redoFirst = await client.jumpHistory(firstId, 'redo');
    expect(redoFirst.ok).toBe(true);
    expect((await client.getModelStructure()).objects).toHaveLength(1);
    const redoSecond = await client.jumpHistory(secondId, 'redo');
    expect(redoSecond.ok).toBe(true);
    expect((await client.getModelStructure()).objects).toHaveLength(2);
    await expect(client.jumpHistory(secondId, 'redo')).rejects.toThrow('outside the requested direction');
    await expect(client.jumpHistory('entry-999999', 'undo')).rejects.toThrow('stale or unavailable');
  });

  it('does not create a no-op entry and abort restores the model', async () => {
    const client = createClient(async () => createMockModule());
    const before = context();
    const transaction = await client.beginHistory('No-op', 'project', before);
    const status = await client.commitHistory(transaction, before);
    expect(status.canUndo).toBe(false);
    const aborted = await client.beginHistory('Abort', 'project', before);
    await client.addShape('Cube');
    await expect(client.abortHistory(aborted)).resolves.toMatchObject({ ok: true });
    expect((await client.getModelStructure()).objects).toHaveLength(0);
    await expect(client.undoHistory()).rejects.toThrow('no undo');
  });

  it('serializes the helper and enforces one active Worker writer', async () => {
    const channel = new Channel();
    const client = createWorkerClient(channel);
    void startWorker(async () => createMockModule(), (message) => channel.post(message), (fn) => channel.onMessage(fn));
    const before = context();
    const wrapped = await client.runProjectHistoryTransaction('Add Cube', 'project', before,
      async () => client.addShape('Cube'), before);
    expect(wrapped.status.canUndo).toBe(true);
    const active = await client.beginHistory('Second', 'project', before);
    await expect(client.beginHistory('Cross-writer', 'project', before)).rejects.toThrow('already active');
    await expect(client.commitHistory('tx-stale', before)).rejects.toThrow('stale');
    await client.abortHistory(active);
    await expect(client.undoHistory()).resolves.toMatchObject({ ok: true });
  });

  it('keeps Save as a checkpoint and skips context-only records', async () => {
    const client = createClient(async () => createMockModule());
    const before = context('plate-1');
    const first = await client.runProjectHistoryTransaction('Add Cube', 'project', before,
      async () => client.addShape('Cube'), before);
    expect(first.status.dirty).toBe(true);
    const saved = await client.markHistorySaved(before);
    expect(saved.dirty).toBe(false);
    const contextAfter = context('plate-2');
    const contextTx = await client.beginHistory('Active Plate', 'context', before);
    const contextStatus = await client.commitHistory(contextTx, contextAfter);
    expect(contextStatus.dirty).toBe(false);
    expect(contextStatus.undoEntries).toHaveLength(1);
    const undone = await client.undoHistory();
    expect(undone.ok).toBe(true);
    if (!undone.ok) throw new Error('missing restore');
    // The saved checkpoint is the post-project frame. Skipping the context
    // record still undoes that project operation, so the baseline is dirty
    // relative to the saved frame.
    expect(undone.status.dirty).toBe(true);
    expect(undone.context.activePlateId).toBe('plate-1');
    const redone = await client.redoHistory();
    expect(redone.ok).toBe(true);
    if (!redone.ok) throw new Error('missing saved-frame redo');
    expect(redone.status.dirty).toBe(false);
    const reset = await client.resetHistory(context('fresh'));
    expect(reset.canUndo).toBe(false);
    expect(reset.canRedo).toBe(false);
    expect(reset.dirty).toBe(false);
  });

  it('skips consecutive context records in one-step navigation and truncates their branch', async () => {
    const client = createClient(async () => createMockModule());
    const baseline = context('plate-1');
    const first = await client.runProjectHistoryTransaction('Add Cube', 'project', baseline,
      async () => client.addShape('Cube'), baseline);
    expect(first.status.dirty).toBe(true);
    const saved = await client.markHistorySaved(baseline);
    expect(saved.dirty).toBe(false);

    const contextOne = await client.recordHistoryContext('Selection 1', context('plate-2'));
    expect(contextOne.dirty).toBe(false);
    const contextTwo = await client.recordHistoryContext('Selection 2', context('plate-3'));
    expect(contextTwo.dirty).toBe(false);
    expect(contextTwo.undoEntries).toHaveLength(1);

    const undone = await client.undoHistory();
    expect(undone.ok).toBe(true);
    if (!undone.ok) throw new Error('missing context-skipping restore');
    expect((await client.getModelStructure()).objects).toHaveLength(0);
    expect(undone.context.activePlateId).toBe('plate-1');
    expect(undone.status.dirty).toBe(true);
    expect(undone.status.canRedo).toBe(true);

    const redone = await client.redoHistory();
    expect(redone.ok).toBe(true);
    if (!redone.ok) throw new Error('missing symmetric redo restore');
    expect((await client.getModelStructure()).objects).toHaveLength(1);
    expect(redone.context.activePlateId).toBe('plate-1');
    expect(redone.status.dirty).toBe(false);
    expect(redone.status.canRedo).toBe(false);

    await client.undoHistory();
    const branched = await client.recordHistoryContext('New Selection', context('plate-branch'));
    expect(branched.canRedo).toBe(false);
  });

  it('restores project selection context and truncates redo after a new context record', async () => {
    const client = createClient(async () => createMockModule());
    const before = context('plate-1');
    const selected: HistoryContext = {
      selection: { mode: 'part', objectIds: [11], partIds: [22], instanceIds: [33] },
      activePlateId: 'plate-1', gizmo: { type: 'move' }, projectConfigOverlay: {},
    };
    await client.runProjectHistoryTransaction('Add Cube', 'project', before,
      async () => client.addShape('Cube'), selected);
    await client.markHistorySaved(selected);
    const changed = await client.recordHistoryContext('Selection', {
      ...selected,
      selection: { ...selected.selection, partIds: [23] },
    });
    expect(changed.dirty).toBe(false);
    expect(changed.undoEntries).toHaveLength(1);
    const undone = await client.undoHistory();
    expect(undone.ok).toBe(true);
    if (!undone.ok) throw new Error('missing restore');
    expect(undone.context.selection.partIds).toEqual([]);
    expect(undone.context.activePlateId).toBe('plate-1');
    const projectRestored = await client.redoHistory();
    expect(projectRestored.ok).toBe(true);
    if (!projectRestored.ok) throw new Error('missing project restore');
    expect(projectRestored.context.selection.partIds).toEqual([22]);
    await client.recordHistoryContext('Selection', {
      ...selected,
      selection: { ...selected.selection, partIds: [23] },
    });
    const afterUndo = await client.undoHistory();
    expect(afterUndo.ok).toBe(true);
    if (!afterUndo.ok) throw new Error('missing baseline restore');
    expect(afterUndo.context.selection.partIds).toEqual([]);
    const truncated = await client.recordHistoryContext('Selection', {
      ...selected,
      selection: { ...selected.selection, objectIds: [99] },
    });
    expect(truncated.canRedo).toBe(false);
    // This branch discards the saved checkpoint itself, so the conservative
    // dirty rule applies even though the new record is context-only.
    expect(truncated.dirty).toBe(true);
  });

  it('rejects future and past context IDs from the directional jump API', async () => {
    const client = createClient(async () => createMockModule());
    const baseline = context('plate-1');
    await client.runProjectHistoryTransaction('Add Cube', 'project', baseline,
      async () => client.addShape('Cube'), baseline);
    await client.recordHistoryContext('Selection', context('plate-2'));
    await expect(client.jumpHistory('entry-2', 'undo')).rejects.toThrow('not a directional project operation');
    await client.undoHistory();
    await expect(client.jumpHistory('entry-2', 'redo')).rejects.toThrow('not a directional project operation');
  });

  it('keeps opt-in nested coalesced transactions dormant and publishes one entry', async () => {
    const client = createClient(async () => createMockModule());
    const before = context('plate-1');
    const outer = await client.beginHistory('Paint stroke', 'project', before);
    await client.addShape('Cube');
    await expect(client.beginHistory('Rejected child', 'project', before, {
      coalesce: true, parentTransactionId: 'stale',
    })).rejects.toThrow('already active');
    const inner = await client.beginHistory('Paint sample', 'project', before, {
      coalesce: true, parentTransactionId: outer,
    });
    await client.addShape('Cube');
    const nestedStatus = await client.commitHistory(inner, before);
    expect(nestedStatus.activeTransactionId).toBe(outer);
    const final = await client.commitHistory(outer, before);
    expect(final.undoEntries).toHaveLength(1);
    expect((await client.getModelStructure()).objects).toHaveLength(2);
  });
});
