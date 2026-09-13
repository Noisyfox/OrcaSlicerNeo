import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryContext, HistoryStatus, RestoreResult } from '@slicer/client';
import { createHistoryRestoreCoordinator } from './restoreCoordinator';
import { useHistoryRestoreStore } from '../stores/useHistoryRestoreStore';
import { useSlicerStore } from '../stores/useSlicerStore';
import { useProjectStore } from '../stores/useProjectStore';
import { useHistoryNavigationStore } from '../stores/useHistoryNavigationStore';
import { runProjectMutationOperation } from '../components/workspace/actions/historyMutation';
import { useHistoryDiagnosticsStore } from './historyDiagnostics';

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
const fullImpact = {
  version: 1 as const, model: 'full' as const, plateSession: true, filamentRack: true,
  projectOverlay: true, selectionContext: true, primeTower: true, preview: 'all' as const,
};
const directImpact = {
  ...fullImpact, model: 'none' as const, filamentRack: false, preview: 'current-plate' as const,
};
const success = (revision = 1): RestoreResult => ({ ok: true, context,
  status: { ...status, revision }, impact: fullImpact });

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
    useHistoryDiagnosticsStore.getState().reset();
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
      runtime: { undoHistory, redoHistory: vi.fn(async () => success(2)), jumpHistory: vi.fn(), cancel: vi.fn(), getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false as const, error: 'unused' })), getHistoryStatus: vi.fn(async () => status) },
      sceneInteraction: fakeScene(),
      refreshModel,
    });

    const restore = coordinator.restore('undo');
    await vi.waitFor(() => expect(refreshModel).toHaveBeenCalledOnce());
    expect(useHistoryRestoreStore.getState().phase).toBe('restoring');
    expect(useHistoryRestoreStore.getState().snapshotSuppressed).toBe(true);
    const redo = coordinator.restore('redo');
    expect(redo).not.toBe(restore);

    releaseProjection();
    await expect(restore).resolves.toBe(true);
    await expect(redo).resolves.toBe(true);
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

  it('reports split full/direct restore projection counters without retaining history data', async () => {
    const direct: RestoreResult = { ok: true, context, status, impact: directImpact };
    const coordinator = createHistoryRestoreCoordinator({
      runtime: {
        undoHistory: vi.fn(async () => direct), redoHistory: vi.fn(async () => success(2)), jumpHistory: vi.fn(),
        cancel: vi.fn(), getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false as const, error: 'unused' })),
        getHistoryStatus: vi.fn(async () => status),
      },
      sceneInteraction: fakeScene(), refreshModel: vi.fn(async () => undefined),
    });

    await expect(coordinator.restore('undo')).resolves.toBe(true);
    let diagnostics = useHistoryDiagnosticsStore.getState().app;
    expect(diagnostics.directRestore.count).toBe(1);
    expect(diagnostics.fullRestore.count).toBe(0);
    expect(diagnostics.projection.count).toBe(1);
    expect(diagnostics.directPrimeTowerModelReloads).toBe(0);
    expect(diagnostics.fullRestoreModelReloads).toBe(0);

    await expect(coordinator.restore('redo')).resolves.toBe(true);
    diagnostics = useHistoryDiagnosticsStore.getState().app;
    expect(diagnostics.fullRestore.count).toBe(1);
    expect(diagnostics.fullRestoreModelReloads).toBe(1);
    expect(diagnostics.filamentRefresh.count).toBe(2);
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

  it('passes a narrow Prime Tower receipt through without publishing a filament rack', async () => {
    const narrow: RestoreResult = { ok: true, context, status, impact: {
      version: 1, model: 'none', plateSession: true, filamentRack: false,
      projectOverlay: true, selectionContext: true, primeTower: true, preview: 'current-plate',
    }, primeTowerReceipt: { version: 1, state: 'available', plateId: 'plate-1', revision: 7,
      position: { x: 12, y: 34 }, footprint: { minX: 12, maxX: 32, minY: 34, maxY: 50 } } };
    const refreshModel = vi.fn(async () => undefined);
    const publishRestoredFilamentRack = vi.fn(async () => undefined);
    const coordinator = createHistoryRestoreCoordinator({
      runtime: { undoHistory: vi.fn(async () => narrow), redoHistory: vi.fn(), jumpHistory: vi.fn(), cancel: vi.fn(), getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false as const, error: 'unused' })), getHistoryStatus: vi.fn(async () => status) },
      sceneInteraction: fakeScene(), refreshModel, publishRestoredFilamentRack,
    });
    await expect(coordinator.restore('undo')).resolves.toBe(true);
    expect(refreshModel).toHaveBeenCalledWith(context, narrow.impact, expect.any(Number), narrow.primeTowerReceipt);
    expect(publishRestoredFilamentRack).not.toHaveBeenCalled();
  });

  it('executes every rapid same-direction intent serially instead of joining or dropping it', async () => {
    const calls: number[] = [];
    let active = 0;
    let maximumActive = 0;
    let revision = 1;
    const undoHistory = vi.fn(async () => {
      calls.push(calls.length + 1);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return success(++revision);
    });
    const coordinator = createHistoryRestoreCoordinator({
      runtime: { undoHistory, redoHistory: vi.fn(), jumpHistory: vi.fn(), cancel: vi.fn(), getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false as const, error: 'unused' })), getHistoryStatus: vi.fn(async () => status) },
      sceneInteraction: fakeScene(), refreshModel: vi.fn(async () => undefined),
    });

    await expect(Promise.all([
      coordinator.restore('undo'), coordinator.restore('undo'), coordinator.restore('undo'),
    ])).resolves.toEqual([true, true, true]);
    expect(calls).toEqual([1, 2, 3]);
    expect(maximumActive).toBe(1);
  });

  it('resolves a queued opposite direction on the cursor committed by the earlier intent', async () => {
    let cursor = 2;
    let revision = 1;
    const undoHistory = vi.fn(async () => {
      expect(cursor).toBe(2);
      cursor -= 1;
      return success(++revision);
    });
    const redoHistory = vi.fn(async () => {
      // This assertion proves the coordinator did not reject Redo from the
      // stale React status that existed before the queued Undo committed.
      expect(cursor).toBe(1);
      cursor += 1;
      return success(++revision);
    });
    const coordinator = createHistoryRestoreCoordinator({
      runtime: { undoHistory, redoHistory, jumpHistory: vi.fn(), cancel: vi.fn(), getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false as const, error: 'unused' })), getHistoryStatus: vi.fn(async () => status) },
      sceneInteraction: fakeScene(), refreshModel: vi.fn(async () => undefined),
    });

    await expect(Promise.all([coordinator.restore('undo'), coordinator.restore('redo')])).resolves.toEqual([true, true]);
    expect(cursor).toBe(2);
  });

  it('keeps direct jumps ordered with ordinary project mutations and validates them at the latest native revision', async () => {
    const events: string[] = [];
    let nativeRevision = 0;
    const coordinator = createHistoryRestoreCoordinator({
      runtime: {
        undoHistory: vi.fn(async () => {
          events.push(`undo@${nativeRevision}`);
          nativeRevision += 1;
          return success(nativeRevision);
        }),
        redoHistory: vi.fn(),
        jumpHistory: vi.fn(async (entryId: string, direction: string) => {
          events.push(`jump:${entryId}:${direction}@${nativeRevision}`);
          expect(nativeRevision).toBe(2);
          nativeRevision += 1;
          return success(nativeRevision);
        }),
        cancel: vi.fn(), getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false as const, error: 'unused' })), getHistoryStatus: vi.fn(async () => status),
      },
      sceneInteraction: fakeScene(), refreshModel: vi.fn(async () => undefined),
    });

    const undo = coordinator.restore('undo');
    const mutation = runProjectMutationOperation(async () => {
      events.push(`mutation@${nativeRevision}`);
      nativeRevision += 1;
    });
    const jump = coordinator.restore({ jump: 'retained-entry', direction: 'redo' });

    await expect(Promise.all([undo, mutation, jump])).resolves.toEqual([true, undefined, true]);
    expect(events).toEqual(['undo@0', 'mutation@1', 'jump:retained-entry:redo@2']);
  });

  it('holds later native navigation behind a slow projection and leaves the newer status projected last', async () => {
    let releaseFirstProjection!: () => void;
    let releaseSecondProjection!: () => void;
    const firstProjection = new Promise<void>((resolve) => { releaseFirstProjection = resolve; });
    const secondProjection = new Promise<void>((resolve) => { releaseSecondProjection = resolve; });
    const revision = useHistoryNavigationStore.getState().status?.revision ?? 0;
    let projectionCount = 0;
    const refreshModel = vi.fn(async () => {
      projectionCount += 1;
      return projectionCount === 1 ? firstProjection : secondProjection;
    });
    const redoHistory = vi.fn(async () => success(revision + 2));
    const coordinator = createHistoryRestoreCoordinator({
      runtime: { undoHistory: vi.fn(async () => success(revision + 1)), redoHistory, jumpHistory: vi.fn(), cancel: vi.fn(), getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false as const, error: 'unused' })), getHistoryStatus: vi.fn(async () => status) },
      sceneInteraction: fakeScene(), refreshModel,
    });

    const undo = coordinator.restore('undo');
    const redo = coordinator.restore('redo');
    await vi.waitFor(() => expect(refreshModel).toHaveBeenCalledOnce());
    expect(redoHistory).not.toHaveBeenCalled();
    releaseFirstProjection();
    await expect(undo).resolves.toBe(true);
    await vi.waitFor(() => expect(redoHistory).toHaveBeenCalledOnce());
    expect(useHistoryNavigationStore.getState().status?.revision).toBe(revision + 2);
    releaseSecondProjection();
    await expect(redo).resolves.toBe(true);
    expect(useHistoryNavigationStore.getState().status?.revision).toBe(revision + 2);
  });
});
