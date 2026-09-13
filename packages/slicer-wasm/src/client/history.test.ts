import { describe, expect, it } from 'vitest';
import { normalizePrimeTowerRestoreReceipt } from './client';
import type {
  HistoryContext, HistoryStatus, MockHistoryRuntime, RestoreResult,
  StableInstanceId, StableObjectId, StablePartId, StablePlateId,
} from './history';

const context: HistoryContext = {
  selection: {
    mode: 'instance',
    objectIds: [101 as StableObjectId],
    partIds: [202 as StablePartId],
    instanceIds: [303 as StableInstanceId],
  },
  activePlateId: 'plate-session-1-plate-1' as StablePlateId,
  gizmo: { type: 'move', state: { axis: 'x', visible: true } },
  projectConfigOverlay: { object: { infillDensity: 0.2 } },
};

const status: HistoryStatus = {
  canUndo: true,
  canRedo: false,
  undoLabel: 'Move',
  undoEntries: [{ id: 'entry-1', label: 'Move', category: 'project' }],
  redoEntries: [],
  cursor: 1,
  savedCheckpoint: 0,
  savedCheckpointEvicted: false,
  dirty: true,
  bytesUsed: 128,
  byteBudget: 256 * 1024 * 1024,
  optionalBytesReleased: 0, evictedEntryCount: 0, lastEvictedEntryId: null,
  oldestRetainedEntryId: 'entry-0', oversizedEntryRetained: false,
  disabled: false,
  activeTransactionId: null,
  revision: 1,
};

describe('history contracts', () => {
  const narrowImpact = {
    version: 1 as const, model: 'none' as const, plateSession: true, filamentRack: false,
    projectOverlay: true, selectionContext: true, primeTower: true, preview: 'current-plate' as const,
  };

  it('keeps stable IDs distinct from positional context in a serializable shape', () => {
    const copy = JSON.parse(JSON.stringify(context)) as HistoryContext;
    expect(copy).toEqual(context);
    expect(copy.selection.objectIds).toEqual([101]);
    expect(copy.selection.partIds).toEqual([202]);
    expect(copy.selection.instanceIds).toEqual([303]);
    expect(copy.activePlateId).toBe('plate-session-1-plate-1');
  });

  it('separates project and context history categories in status entries', () => {
    const contextEntry = { id: 'entry-2', label: 'Selection', category: 'context' as const };
    expect(status.undoEntries[0]?.category).toBe('project');
    expect(contextEntry.category).toBe('context');
    expect(status.canUndo).toBe(true);
    expect(status.canRedo).toBe(false);
  });

  it('allows future callers to type a mock runtime without enabling history', async () => {
    const restore: RestoreResult = { ok: true, context, status, entryId: 'entry-1', impact: {
      version: 1, model: 'full', plateSession: true, filamentRack: true,
      projectOverlay: true, selectionContext: true, primeTower: true, preview: 'all',
    } };
    const mock: MockHistoryRuntime = {
      getHistoryStatus: async () => status,
      undoHistory: async () => restore,
    };

    expect(await mock.getHistoryStatus?.()).toBe(status);
    expect(await mock.undoHistory?.()).toBe(restore);
    expect(mock.beginHistory).toBeUndefined();
  });

  it('normalizes only a versioned direct Prime Tower receipt and preserves the cleared state', () => {
    expect(normalizePrimeTowerRestoreReceipt({
      version: 1, state: 'available', plate_id: 'plate-1', revision: 7,
      position: { x: 12.5, y: 34.5 }, footprint: { min_x: 10, max_x: 20, min_y: 30, max_y: 40 },
    }, narrowImpact, true)).toEqual({
      version: 1, state: 'available', plateId: 'plate-1', revision: 7,
      position: { x: 12.5, y: 34.5 }, footprint: { minX: 10, maxX: 20, minY: 30, maxY: 40 },
    });
    expect(normalizePrimeTowerRestoreReceipt(
      { version: 1, state: 'cleared', plate_id: 'plate-1', revision: 8 }, narrowImpact, true,
    )).toEqual({ version: 1, state: 'cleared', plateId: 'plate-1', revision: 8 });
  });

  it('drops malformed or non-direct receipts so the caller keeps its projection fallback', () => {
    expect(normalizePrimeTowerRestoreReceipt({
      version: 1, state: 'available', plate_id: 'plate-1', revision: 7,
      position: { x: Number.NaN, y: 34.5 }, footprint: { min_x: 10, max_x: 20, min_y: 30, max_y: 40 },
    }, narrowImpact, true)).toBeUndefined();
    expect(normalizePrimeTowerRestoreReceipt({
      version: 1, state: 'cleared', plate_id: 'plate-1', revision: 7,
    }, { ...narrowImpact, model: 'full' }, true)).toBeUndefined();
    expect(normalizePrimeTowerRestoreReceipt({
      version: 1, state: 'cleared', plate_id: 'plate-1', revision: 7,
    }, narrowImpact, false)).toBeUndefined();
  });
});
