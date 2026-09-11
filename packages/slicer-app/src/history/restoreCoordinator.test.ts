import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryContext, HistoryStatus, RestoreResult } from '@slicer/client';
import { createHistoryRestoreCoordinator } from './restoreCoordinator';
import { useHistoryRestoreStore } from '../stores/useHistoryRestoreStore';
import { useSlicerStore } from '../stores/useSlicerStore';
import { useProjectStore } from '../stores/useProjectStore';

const context: HistoryContext = {
  selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: 'plate-1', gizmo: null, projectConfigOverlay: {},
};
const status: HistoryStatus = {
  canUndo: false, canRedo: false, undoEntries: [], redoEntries: [], cursor: 0,
  savedCheckpoint: 0, savedCheckpointEvicted: false, dirty: false,
  bytesUsed: 0, byteBudget: 256 * 1024 * 1024, optionalBytesReleased: 0,
  evictedEntryCount: 0, lastEvictedEntryId: null, oldestRetainedEntryId: 'entry-0',
  oversizedEntryRetained: false, disabled: false,
  activeTransactionId: null, revision: 1,
};
const success = (revision = 1): RestoreResult => ({ ok: true, context,
  status: { ...status, revision } });

function fakeScene(activeDrag = false) {
  return {
    activeDrag: activeDrag ? {} : null,
    cancelDrag: vi.fn(),
  } as never;
}

describe('history restore coordinator', () => {
  beforeEach(() => {
    useHistoryRestoreStore.getState().reset();
    useSlicerStore.getState().invalidateSliceResult();
    useProjectStore.getState().reset();
  });

  it('consumes the first shortcut by cancelling a draft drag', async () => {
    const scene = fakeScene(true) as { activeDrag: object | null; cancelDrag: ReturnType<typeof vi.fn> };
    const undoHistory = vi.fn(async () => success());
    const coordinator = createHistoryRestoreCoordinator({
      runtime: { undoHistory, redoHistory: vi.fn(), jumpHistory: vi.fn(), cancel: vi.fn(), getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false as const, error: 'unused' })), getHistoryStatus: vi.fn(async () => status) },
      sceneInteraction: scene as never,
      refreshModel: vi.fn(async () => undefined),
    });
    await expect(coordinator.restore('undo')).resolves.toBe(false);
    expect(scene.cancelDrag).toHaveBeenCalledOnce();
    expect(undoHistory).not.toHaveBeenCalled();
  });

  it('cancels and awaits slicing before restoring, then invalidates its output', async () => {
    let releaseSlice!: () => void;
    const slice = new Promise<void>((resolve) => { releaseSlice = resolve; });
    useSlicerStore.getState().setStatus('slicing');
    const cancelAndWait = vi.fn(async () => { releaseSlice(); await slice; });
    const refreshModel = vi.fn(async () => undefined);
    const coordinator = createHistoryRestoreCoordinator({
      runtime: { undoHistory: vi.fn(async () => success()), redoHistory: vi.fn(), jumpHistory: vi.fn(), cancel: vi.fn(async () => ({ ok: true })), getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false as const, error: 'unused' })), getHistoryStatus: vi.fn(async () => status) },
      sceneInteraction: fakeScene(),
      sliceCoordinator: { cancelAndWait },
      refreshModel,
    });
    const restore = coordinator.restore('undo');
    await Promise.resolve();
    expect(useHistoryRestoreStore.getState().phase).toBe('cancelling-slice');
    expect(cancelAndWait).toHaveBeenCalledOnce();
    releaseSlice();
    await expect(restore).resolves.toBe(true);
    expect(refreshModel).toHaveBeenCalledOnce();
    expect(useSlicerStore.getState().status).toBe('idle');
    expect(useHistoryRestoreStore.getState().phase).toBe('idle');
  });

  it('keeps the old projection on retryable Worker restore failure', async () => {
    useProjectStore.getState().setProject({ dirty: true, dirtyReasons: ['model-transform'] });
    const refreshModel = vi.fn(async () => undefined);
    const failed: RestoreResult = { ok: false, error: {
      code: 'restore-failed', message: 'invalid staged model', retryable: true,
    } };
    const coordinator = createHistoryRestoreCoordinator({
      runtime: { undoHistory: vi.fn(async () => failed), redoHistory: vi.fn(), jumpHistory: vi.fn(), cancel: vi.fn(), getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false as const, error: 'unused' })), getHistoryStatus: vi.fn(async () => status) },
      sceneInteraction: fakeScene(),
      refreshModel,
    });
    await expect(coordinator.restore('undo')).resolves.toBe(false);
    expect(refreshModel).not.toHaveBeenCalled();
    expect(useHistoryRestoreStore.getState().error).toBe('invalid staged model');
    expect(useHistoryRestoreStore.getState().phase).toBe('idle');
    expect(useProjectStore.getState()).toMatchObject({ dirty: true, dirtyReasons: ['model-transform'] });
  });

  it('projects Worker dirty state after undoing to and redoing away from a saved checkpoint', async () => {
    const saved = success();
    const dirtyAgain = { ...success(), status: { ...status, dirty: true, cursor: 2, revision: 2 } };
    const undoHistory = vi.fn(async () => saved);
    const redoHistory = vi.fn(async () => dirtyAgain);
    const coordinator = createHistoryRestoreCoordinator({
      runtime: { undoHistory, redoHistory, jumpHistory: vi.fn(), cancel: vi.fn(), getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false as const, error: 'unused' })), getHistoryStatus: vi.fn(async () => status) },
      sceneInteraction: fakeScene(),
      refreshModel: vi.fn(async () => undefined),
    });

    useProjectStore.getState().setProject({ dirty: true, dirtyReasons: ['model-transform'] });
    await expect(coordinator.restore('undo')).resolves.toBe(true);
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, dirtyReasons: [] });

    await expect(coordinator.restore('redo')).resolves.toBe(true);
    expect(useProjectStore.getState()).toMatchObject({ dirty: true, dirtyReasons: [] });
  });

  it('keeps the restoring phase until the asynchronous projection barrier settles', async () => {
    let releaseProjection!: () => void;
    const projection = new Promise<void>((resolve) => { releaseProjection = resolve; });
    const refreshModel = vi.fn(async () => projection);
    const undoHistory = vi.fn(async () => success());
    const coordinator = createHistoryRestoreCoordinator({
      runtime: { undoHistory, redoHistory: vi.fn(), jumpHistory: vi.fn(), cancel: vi.fn(), getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false as const, error: 'unused' })), getHistoryStatus: vi.fn(async () => status) },
      sceneInteraction: fakeScene(),
      refreshModel,
    });

    const restore = coordinator.restore('undo');
    await vi.waitFor(() => expect(refreshModel).toHaveBeenCalledOnce());
    expect(useHistoryRestoreStore.getState().phase).toBe('restoring');
    expect(useHistoryRestoreStore.getState().snapshotSuppressed).toBe(true);
    expect(coordinator.restore('redo')).toBe(restore);

    releaseProjection();
    await expect(restore).resolves.toBe(true);
    expect(useHistoryRestoreStore.getState().phase).toBe('idle');
  });

  it('does not let a superseded projection return the newer restore to idle', async () => {
    let releaseProjection!: () => void;
    const projection = new Promise<void>((resolve) => { releaseProjection = resolve; });
    const coordinator = createHistoryRestoreCoordinator({
      runtime: { undoHistory: vi.fn(async () => success()), redoHistory: vi.fn(), jumpHistory: vi.fn(), cancel: vi.fn(), getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false as const, error: 'unused' })), getHistoryStatus: vi.fn(async () => status) },
      sceneInteraction: fakeScene(),
      refreshModel: vi.fn(async () => projection),
    });

    const restore = coordinator.restore('undo');
    await Promise.resolve();
    useHistoryRestoreStore.getState().advanceRevision();
    releaseProjection();
    await expect(restore).resolves.toBe(false);
    expect(useHistoryRestoreStore.getState().phase).toBe('restoring');
  });

  it('cleans up the restore barrier when mesh/context projection fails', async () => {
    const coordinator = createHistoryRestoreCoordinator({
      runtime: { undoHistory: vi.fn(async () => success()), redoHistory: vi.fn(), jumpHistory: vi.fn(), cancel: vi.fn(), getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false as const, error: 'unused' })), getHistoryStatus: vi.fn(async () => status) },
      sceneInteraction: fakeScene(),
      refreshModel: vi.fn(async () => { throw new Error('mesh projection failed'); }),
    });

    await expect(coordinator.restore('undo')).resolves.toBe(false);
    expect(useHistoryRestoreStore.getState()).toMatchObject({
      phase: 'idle', error: 'mesh projection failed', snapshotSuppressed: false,
    });
  });

  it('keeps a successful native restore successful when rack publication fails', async () => {
    const coordinator = createHistoryRestoreCoordinator({
      runtime: { undoHistory: vi.fn(async () => success()), redoHistory: vi.fn(), jumpHistory: vi.fn(), cancel: vi.fn(), getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false as const, error: 'unused' })), getHistoryStatus: vi.fn(async () => status) },
      sceneInteraction: fakeScene(),
      refreshModel: vi.fn(async () => undefined),
      publishRestoredFilamentRack: vi.fn(async () => { throw new Error('preference read failed'); }),
    });
    await expect(coordinator.restore('undo')).resolves.toBe(true);
    expect(useHistoryRestoreStore.getState().phase).toBe('idle');
    expect(useHistoryRestoreStore.getState().error).toBeNull();
  });
});
