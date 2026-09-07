import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneInteractionController } from '../viewport/SceneInteractionController';
import { glVolumeCollection } from '../viewport/GLVolume';
import { TransformHistoryCoordinator } from './transformHistory';
import { useObjectListStore } from '../objectList/useObjectListStore';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';

describe('TransformHistoryCoordinator', () => {
  beforeEach(() => {
    glVolumeCollection.clear();
    useObjectListStore.getState().clear();
    usePlateSessionStore.getState().setSnapshot(null);
  });

  it('opens one Worker transaction and waits for the final commit gate', async () => {
    let releaseMutation!: () => void;
    const mutationRelease = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const runtime = {
      setModelTransform: vi.fn(async () => ({ ok: true })),
      runProjectHistoryTransaction: vi.fn(async (
        _label: string,
        _category: 'project' | 'context',
        _before: unknown,
        mutation: (tx: string) => Promise<unknown>,
        after: unknown | (() => unknown),
      ) => {
        const result = await mutation('tx-1');
        await mutationRelease;
        return { result, status: {
          dirty: true,
          canUndo: true,
          canRedo: false,
          undoEntries: [],
          redoEntries: [],
          cursor: 1,
          savedCheckpoint: 0,
          savedCheckpointEvicted: false,
          bytesUsed: 0,
          byteBudget: 256 * 1024 * 1024,
          disabled: false,
          activeTransactionId: null,
          revision: 1,
        } };
      }),
    };
    const controller = new SceneInteractionController(() => []);
    const history = new TransformHistoryCoordinator(runtime as never, controller);
    history.begin('Move');
    expect(runtime.runProjectHistoryTransaction).toHaveBeenCalledTimes(1);
    expect(runtime.setModelTransform).not.toHaveBeenCalled();
    const commit = history.commit();
    await Promise.resolve();
    releaseMutation();
    await commit;
    expect(runtime.setModelTransform).not.toHaveBeenCalled();
  });

  it('aborts a cancelled transaction without writing transforms', async () => {
    const runtime = {
      setModelTransform: vi.fn(async () => ({ ok: true })),
      runProjectHistoryTransaction: vi.fn(async (
        _label: string,
        _category: 'project' | 'context',
        _before: unknown,
        mutation: (tx: string) => Promise<unknown>,
        _after: unknown | (() => unknown),
      ) => ({ result: await mutation('tx-1'), status: {} as never })),
    };
    const controller = new SceneInteractionController(() => []);
    const history = new TransformHistoryCoordinator(runtime as never, controller);
    history.begin('Rotate');
    await history.abort();
    expect(runtime.setModelTransform).not.toHaveBeenCalled();
  });

  it('serializes rapid discrete commands until each Worker transaction settles', async () => {
    const started: string[] = [];
    const runtime = {
      setModelTransform: vi.fn(async () => ({ ok: true })),
      runProjectHistoryTransaction: vi.fn(async (
        label: string,
        _category: 'project' | 'context',
        _before: unknown,
        mutation: (tx: string) => Promise<unknown>,
        _after: unknown | (() => unknown),
      ) => {
        started.push(label);
        const result = await mutation(`tx-${started.length}`);
        return { result, status: {} as never };
      }),
    };
    const controller = new SceneInteractionController(() => []);
    const history = new TransformHistoryCoordinator(runtime as never, controller);

    history.begin('Move');
    const firstCommit = history.commit();
    history.begin('Rotate');
    const secondCommit = history.commit();

    // The second command is accepted, but beginHistory must wait until the
    // first transaction has fully settled instead of overlapping it.
    expect(started).toEqual(['Move']);
    await firstCommit;
    await secondCommit;
    expect(started).toEqual(['Move', 'Rotate']);
  });
});
