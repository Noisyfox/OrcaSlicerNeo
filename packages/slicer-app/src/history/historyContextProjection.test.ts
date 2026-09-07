import { describe, expect, it } from 'vitest';
import type { HistoryContext } from '@slicer/client';
import { isHistoryContextProjectionReady, type PendingHistoryContext } from './historyContextProjection';

const context: HistoryContext = {
  selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null,
  gizmo: null,
  projectConfigOverlay: {},
};

const pending = (expectedObjectCount: number): PendingHistoryContext => ({
  context,
  historyRevision: 4,
  modelRevision: 9,
  expectedObjectCount,
});
describe('history context projection gate', () => {
  it('rejects old meshes while the restored model revision is loading', () => {
    expect(isHistoryContextProjectionReady(pending(1), 4, 9, 8, 1)).toBe(false);
    expect(isHistoryContextProjectionReady(pending(1), 4, 9, 9, 1)).toBe(true);
  });

  it('accepts an empty baseline only after the empty replacement is published', () => {
    expect(isHistoryContextProjectionReady(pending(0), 4, 9, 8, 1)).toBe(false);
    expect(isHistoryContextProjectionReady(pending(0), 4, 9, 9, 0)).toBe(true);
    expect(isHistoryContextProjectionReady(pending(0), 4, 9, 9, 1)).toBe(false);
  });
});
