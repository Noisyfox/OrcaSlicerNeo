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
});
