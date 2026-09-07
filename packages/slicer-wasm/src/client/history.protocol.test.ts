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
});
