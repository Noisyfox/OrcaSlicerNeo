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

  it('jumps across mixed Add Cube, Move, and Add Plate entries by opaque entry id', async () => {
    const client = createClient(async () => createMockModule());
    const editingContext = context('plate-session-1-plate-1');
    const firstCube = await client.runProjectHistoryTransaction('Add Cube', 'project', editingContext,
      async () => client.addShape('Cube'), editingContext);
    const firstCubeId = firstCube.status.undoEntries[0]?.id;
    if (!firstCubeId) throw new Error('missing first Add Cube entry id');

    const move = await client.beginHistory('Move', 'project', editingContext);
    const transform = { offset: [10, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], mirror: [1, 1, 1] as [number, number, number] };
    expect((await client.setModelTransforms(move, [
      { objectIdx: 0, volumeIdx: 0, instanceIdx: 0, instanceTransform: transform, volumeTransform: { ...transform, offset: [0, 0, 0] } },
    ])).ok).toBe(true);
    await client.commitHistory(move, editingContext);

    const addPlate = await client.runProjectHistoryTransaction('Add Plate', 'project', editingContext,
      async () => client.addPlate(), editingContext);
    expect(addPlate.result.ok).toBe(true);
    const secondCube = await client.runProjectHistoryTransaction('Add Cube', 'project', editingContext,
      async () => client.addShape('Cube'), editingContext);
    const secondCubeId = secondCube.status.undoEntries[0]?.id;
    if (!secondCubeId) throw new Error('missing second Add Cube entry id');

    const undone = await client.jumpHistory(firstCubeId, 'undo');
    expect(undone.ok).toBe(true);
    expect((await client.getModelStructure()).objects).toHaveLength(0);
    const undonePlates = await client.getPlateSessionSnapshot();
    expect(undonePlates.ok).toBe(true);
    if (!undonePlates.ok) throw new Error(undonePlates.error);
    expect(undonePlates.plates).toHaveLength(1);

    const redone = await client.jumpHistory(secondCubeId, 'redo');
    expect(redone.ok).toBe(true);
    expect((await client.getModelStructure()).objects).toHaveLength(2);
    expect((await client.getModelMesh()).objects[0]?.instanceTransform.offset[0]).toBe(10);
    const redonePlates = await client.getPlateSessionSnapshot();
    expect(redonePlates.ok).toBe(true);
    if (!redonePlates.ok) throw new Error(redonePlates.error);
    expect(redonePlates.plates).toHaveLength(2);
  });

  it('undoes the first Cube after an empty-scene Add Plate', async () => {
    const client = createClient(async () => createMockModule());
    const editingContext = context('plate-session-1-plate-1');
    const addedPlate = await client.runProjectHistoryTransaction('Add Plate', 'project', editingContext,
      async () => client.addPlate(), editingContext);
    expect(addedPlate.result.ok).toBe(true);
    const twoPlates = await client.getPlateSessionSnapshot();
    expect(twoPlates.ok).toBe(true);
    if (!twoPlates.ok) throw new Error(twoPlates.error);
    expect(twoPlates.plates).toHaveLength(2);

    await client.runProjectHistoryTransaction('Add Cube', 'project', editingContext,
      async () => client.addShape('Cube'), editingContext);
    expect((await client.getModelStructure()).objects).toHaveLength(1);

    const undone = await client.undoHistory();
    expect(undone.ok).toBe(true);
    expect((await client.getModelStructure()).objects).toHaveLength(0);
    const restoredPlates = await client.getPlateSessionSnapshot();
    expect(restoredPlates.ok).toBe(true);
    if (!restoredPlates.ok) throw new Error(restoredPlates.error);
    expect(restoredPlates.plates).toHaveLength(2);

    expect((await client.redoHistory()).ok).toBe(true);
    expect((await client.getModelStructure()).objects).toHaveLength(1);
  });

  it('redoes a Move after Add Cube was fully restored', async () => {
    const client = createClient(async () => createMockModule());
    const editingContext = context('plate-session-1-plate-1');
    await client.runProjectHistoryTransaction('Add Cube', 'project', editingContext,
      async () => client.addShape('Cube'), editingContext);
    const move = await client.beginHistory('Move', 'project', editingContext);
    const moved = {
      offset: [25, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
      mirror: [1, 1, 1] as [number, number, number],
    };
    const identity = { ...moved, offset: [0, 0, 0] as [number, number, number] };
    expect((await client.setModelTransforms(move, [
      { objectIdx: 0, volumeIdx: 0, instanceIdx: 0, instanceTransform: moved, volumeTransform: identity },
    ])).ok).toBe(true);
    await client.commitHistory(move, editingContext);

    expect((await client.undoHistory()).ok).toBe(true);
    expect((await client.undoHistory()).ok).toBe(true);
    expect((await client.getModelStructure()).objects).toHaveLength(0);
    expect((await client.redoHistory()).ok).toBe(true);
    expect((await client.getModelStructure()).objects).toHaveLength(1);
    expect((await client.redoHistory()).ok).toBe(true);
    expect((await client.getModelMesh()).objects[0]?.instanceTransform.offset[0]).toBe(25);
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

  it('applies a multi-object transform in one transaction receipt and undo/redo entry', async () => {
    const client = createClient(async () => createMockModule());
    const before = context('plate-session-1-plate-1');
    await client.addShape('Cube');
    await client.addShape('Cube');
    const transaction = await client.beginHistory('Move', 'project', before);
    const transform = (x: number) => ({ offset: [x, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], mirror: [1, 1, 1] as [number, number, number] });
    const result = await client.setModelTransforms(transaction, [
      { objectIdx: 0, volumeIdx: 0, instanceIdx: 0, instanceTransform: transform(10), volumeTransform: transform(0) },
      { objectIdx: 1, volumeIdx: 0, instanceIdx: 0, instanceTransform: transform(20), volumeTransform: transform(0) },
    ]);
    expect(result.ok).toBe(true);
    const committed = await client.commitHistory(transaction, before);
    expect(committed.undoEntries).toHaveLength(1);
    expect((await client.getModelMesh()).objects.map((entry) => entry.instanceTransform.offset[0])).toEqual([10, 20]);
    expect((await client.undoHistory()).ok).toBe(true);
    expect((await client.getModelMesh()).objects.map((entry) => entry.instanceTransform.offset[0])).toEqual([0, 0]);
    expect((await client.redoHistory()).ok).toBe(true);
    expect((await client.getModelMesh()).objects.map((entry) => entry.instanceTransform.offset[0])).toEqual([10, 20]);
  });

  it('rejects an invalid or stale batch without partially changing the Worker model or revision', async () => {
    const client = createClient(async () => createMockModule());
    const before = context('plate-session-1-plate-1');
    await client.addShape('Cube');
    await client.addShape('Cube');
    const revision = (await client.getHistoryStatus()).revision;
    const transaction = await client.beginHistory('Move', 'project', before);
    const identity = { offset: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], mirror: [1, 1, 1] as [number, number, number] };
    const moved = { ...identity, offset: [10, 0, 0] as [number, number, number] };
    await expect(client.setModelTransforms(transaction, [
      { objectIdx: 0, volumeIdx: 0, instanceIdx: 0, instanceTransform: moved, volumeTransform: identity },
      { objectIdx: 99, volumeIdx: 0, instanceIdx: 0, instanceTransform: moved, volumeTransform: identity },
    ])).resolves.toMatchObject({ ok: false });
    expect((await client.getModelMesh()).objects.map((entry) => entry.instanceTransform.offset[0])).toEqual([0, 0]);
    await client.abortHistory(transaction);
    expect((await client.getHistoryStatus()).revision).toBe(revision);
    const fresh = await client.beginHistory('Move', 'project', before);
    await expect(client.setModelTransforms('tx-stale', [
      { objectIdx: 0, volumeIdx: 0, instanceIdx: 0, instanceTransform: moved, volumeTransform: identity },
    ])).resolves.toMatchObject({ ok: false });
    expect((await client.getModelMesh()).objects[0]?.instanceTransform.offset).toEqual([0, 0, 0]);
    await client.abortHistory(fresh);
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

  it('keeps Save as a checkpoint while UI context remains outside history', async () => {
    const client = createClient(async () => createMockModule());
    const before = context('plate-1');
    const first = await client.runProjectHistoryTransaction('Add Cube', 'project', before,
      async () => client.addShape('Cube'), before);
    expect(first.status.dirty).toBe(true);
    const saved = await client.markHistorySaved(before);
    expect(saved.dirty).toBe(false);
    const statusAfterUiContext = await client.getHistoryStatus();
    expect(statusAfterUiContext).toEqual(saved);
    const undone = await client.undoHistory();
    expect(undone.ok).toBe(true);
    if (!undone.ok) throw new Error('missing restore');
    // The saved checkpoint is the post-project frame, so Undoing that project
    // operation reaches the baseline and becomes dirty relative to Save.
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

  it('keeps redo across UI context changes and attaches the latest context to the next mutation', async () => {
    const client = createClient(async () => createMockModule());
    const addedPlate = await client.addPlate();
    if (!addedPlate.ok) throw new Error(addedPlate.error);
    const firstPlateId = addedPlate.plates[0].plateId;
    const secondPlateId = addedPlate.plates[1].plateId;
    await client.selectPlate(firstPlateId);
    const before = context(firstPlateId);
    await client.resetHistory(before);
    const selectedAfterA: HistoryContext = {
      selection: { mode: 'part', objectIds: [11], partIds: [22], instanceIds: [33] },
      activePlateId: firstPlateId, gizmo: { type: 'move' }, projectConfigOverlay: {},
    };
    await client.runProjectHistoryTransaction('Mutation A', 'project', before,
      async () => client.addShape('Cube'), selectedAfterA);
    const undone = await client.undoHistory();
    expect(undone.ok).toBe(true);
    if (!undone.ok) throw new Error('missing restore');
    const beforeUiChanges = undone.status;

    // Selecting another object, clearing it, and switching plate are renderer
    // context only. Plate selection exercises the actual runtime command; the
    // selection changes intentionally make no history call.
    const selectedBeforeB: HistoryContext = {
      selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
      activePlateId: secondPlateId, gizmo: null, projectConfigOverlay: {},
    };
    expect((await client.selectPlate(secondPlateId)).ok).toBe(true);
    const afterUiChanges = await client.getHistoryStatus();
    expect(afterUiChanges).toMatchObject({
      canRedo: true,
      cursor: beforeUiChanges.cursor,
      revision: beforeUiChanges.revision,
      redoEntries: beforeUiChanges.redoEntries,
    });

    const redone = await client.redoHistory();
    expect(redone.ok).toBe(true);
    if (!redone.ok) throw new Error('missing project redo');
    expect(redone.context).toMatchObject(selectedAfterA);

    await client.undoHistory();
    await client.selectPlate(secondPlateId);
    const mutationB = await client.runProjectHistoryTransaction('Mutation B', 'project', selectedBeforeB,
      async () => client.addShape('Cube'), selectedBeforeB);
    expect(mutationB.status.canRedo).toBe(false);
    const undoB = await client.undoHistory();
    expect(undoB.ok).toBe(true);
    if (!undoB.ok) throw new Error('missing mutation B undo');
    expect(undoB.context).toMatchObject(selectedBeforeB);
  });

  it('rejects a standalone context transaction', async () => {
    const client = createClient(async () => createMockModule());
    const baseline = context('plate-1');
    await expect(client.beginHistory('Selection', 'context' as never, baseline))
      .rejects.toThrow('history category must be project');
    expect(await client.getHistoryStatus()).toMatchObject({ canUndo: false, canRedo: false });
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
