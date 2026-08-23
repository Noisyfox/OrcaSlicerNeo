import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlicerRuntime } from '@orca/platform-contract';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { deleteSelectedObjects } from './deleteSelection';

function makeRuntime(deleteObjects: SlicerRuntime['deleteObjects']): SlicerRuntime {
  return {
    deleteObjects,
    getModelStructure: async () => ({
      ok: true,
      objects: [
        { index: 0, id: 101 },
        { index: 1, id: 202 },
      ],
    }),
  } as unknown as SlicerRuntime;
}

describe('deleteSelectedObjects', () => {
  beforeEach(() => {
    useSlicerStore.setState({ status: 'done', resultExported: true, error: 'stale' });
    useSettingsStore.setState({ modelLoaded: true, modelRevision: 3 });
  });

  it('no-ops without touching the runtime on an empty index list', async () => {
    const deleteObjects = vi.fn(async () => ({ ok: true }));
    const r = await deleteSelectedObjects(makeRuntime(deleteObjects), []);
    expect(r.ok).toBe(true);
    expect(deleteObjects).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().modelRevision).toBe(3);
  });

  it('deletes, invalidates the slice, and refreshes the model when objects remain', async () => {
    const deleteObjects = vi.fn(async () => ({ ok: true, objects: 2, deleted: 1 }));
    const r = await deleteSelectedObjects(makeRuntime(deleteObjects), [0]);
    expect(r.ok).toBe(true);
    expect(deleteObjects).toHaveBeenCalledWith([101]);
    expect(useSlicerStore.getState().status).toBe('idle');
    expect(useSlicerStore.getState().resultExported).toBe(false);
    expect(useSlicerStore.getState().error).toBeNull();
    expect(useSettingsStore.getState().modelLoaded).toBe(true);
    expect(useSettingsStore.getState().modelRevision).toBe(4);
  });

  it('flips modelLoaded off when the delete empties the plate', async () => {
    const deleteObjects = vi.fn(async () => ({ ok: true, objects: 0, deleted: 1 }));
    const r = await deleteSelectedObjects(makeRuntime(deleteObjects), [0]);
    expect(r.ok).toBe(true);
    expect(useSettingsStore.getState().modelLoaded).toBe(false);
  });

  it('reports a failed delete and records the bridge error', async () => {
    const deleteObjects = vi.fn(async () => ({ ok: false, error: 'object not found' }));
    const r = await deleteSelectedObjects(makeRuntime(deleteObjects), [0]);
    expect(r.ok).toBe(false);
    expect(deleteObjects).toHaveBeenCalledWith([101]);
    expect(useSlicerStore.getState().error).toBe('object not found');
  });

  it('fails closed when the selection no longer maps to a live object', async () => {
    const deleteObjects = vi.fn(async () => ({ ok: true }));
    const r = await deleteSelectedObjects(makeRuntime(deleteObjects), [9]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no longer matches');
    expect(deleteObjects).not.toHaveBeenCalled();
    expect(useSlicerStore.getState().error).toContain('no longer matches');
  });
});
