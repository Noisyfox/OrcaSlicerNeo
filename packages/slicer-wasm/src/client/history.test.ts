import { describe, expect, it } from 'vitest';
import { normalizeHistoryContext } from './client';
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
  nativeScopedConfig: { object: { infillDensity: 0.2 } },
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
  evictedEntryCount: 0, lastEvictedEntryId: null,
  oldestRetainedEntryId: 'entry-0', oversizedEntryRetained: false,
  disabled: false,
  activeTransactionId: null,
  revision: 1,
};

describe('history contracts', () => {
  it('keeps stable IDs distinct from positional context in a serializable shape', () => {
    const copy = JSON.parse(JSON.stringify(context)) as HistoryContext;
    expect(copy).toEqual(context);
    expect(copy.selection.objectIds).toEqual([101]);
    expect(copy.selection.partIds).toEqual([202]);
    expect(copy.selection.instanceIds).toEqual([303]);
    expect(copy.activePlateId).toBe('plate-session-1-plate-1');
  });

  it('reports only project history categories in status entries', () => {
    expect(status.undoEntries[0]?.category).toBe('project');
    expect(status.canUndo).toBe(true);
    expect(status.canRedo).toBe(false);
  });

  it('allows future callers to type a mock runtime without enabling history', async () => {
    const restore: RestoreResult = { ok: true, context, status, nativeScopedConfig: {
      version: 1, revision: status.revision, kind: 'full',
      snapshot: { project: {}, objects: {}, parts: {}, plates: {} }, removedTargets: [],
    }, entryId: 'entry-1', sceneDelta: {
      version: 1, objectIds: [101], volumeIds: [202], instanceIds: [303],
      plateIds: ['plate-session-1-plate-1'], objectOrder: [101],
    }, affectedPlateIds: ['plate-session-1-plate-1'], impact: {
      version: 1, model: 'delta', plateSession: true, filamentRack: true,
      presetDrafts: false, nativeScopedConfig: true, selectionContext: true, primeTower: true, preview: 'all',
    } };
    const mock: MockHistoryRuntime = {
      getHistoryStatus: async () => status,
      undoHistory: async () => restore,
    };

    expect(await mock.getHistoryStatus?.()).toBe(status);
    expect(await mock.undoHistory?.()).toBe(restore);
    expect(mock.beginHistory).toBeUndefined();
  });

  it('normalizes native session proof and drops malformed session data', () => {
    const nativeSession = {
      ok: true, version: 1, current_plate_id: 'plate-1',
      plates: [{ plate_id: 'plate-1', display_index: 0, origin: [0, 0, 0], name: 'Plate',
        locked: false, settings: {}, opaque_metadata: [], instance_ids: [303],
        out_of_bounds_instance_ids: [], valid: true }],
      instances: [{ instance_id: 303, object_id: 101, object_index: 0, instance_index: 0,
        plate_id: 'plate-1', member: true, parked: false, unprintable: false, out_of_bounds: false }],
      instance_transforms: [], input_revisions: { 'plate-1': 3 },
    };
    const normalized = normalizeHistoryContext({ ...context, plateSession: nativeSession });
    expect(normalized?.plateSession?.currentPlateId).toBe('plate-1');
    const malformed = normalizeHistoryContext({ ...context, plateSession: { ...nativeSession, instances: [{ malformed: true }] } });
    expect(malformed?.plateSession).toBeUndefined();
  });
});
