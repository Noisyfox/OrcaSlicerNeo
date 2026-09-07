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
    expect((await client.jumpHistory('entry-0')).ok).toBe(true);
    expect((await client.getModelStructure()).objects).toHaveLength(0);
    expect((await client.jumpHistory(redone.entryId)).ok).toBe(true);
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
    expect(undone.status.dirty).toBe(false);
    expect(undone.context.activePlateId).toBe('plate-1');
    const reset = await client.resetHistory(context('fresh'));
    expect(reset.canUndo).toBe(false);
    expect(reset.canRedo).toBe(false);
    expect(reset.dirty).toBe(false);
  });

  it('restores complete selection context and truncates redo after a new context record', async () => {
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
    expect(undone.context.selection.partIds).toEqual([22]);
    expect(undone.context.activePlateId).toBe('plate-1');
    const contextRestored = await client.jumpHistory('entry-2');
    expect(contextRestored.ok).toBe(true);
    if (!contextRestored.ok) throw new Error('missing context restore');
    expect(contextRestored.context.selection.partIds).toEqual([23]);
    const afterUndo = await client.undoHistory();
    expect(afterUndo.ok).toBe(true);
    const truncated = await client.recordHistoryContext('Selection', {
      ...selected,
      selection: { ...selected.selection, objectIds: [99] },
    });
    expect(truncated.canRedo).toBe(false);
    expect(truncated.dirty).toBe(false);
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
