import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlicerRuntime } from '@orca/platform-contract';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { deleteSelection } from './deleteSelection';

const structure = {
  ok: true as const,
  objects: [{
    id: 1, index: 0, name: 'Cube', printable: true, instanceCount: 2,
    volumes: [
      { id: 10, index: 0, name: 'Part 1', type: 'model_part' as const, isSplittable: false },
      { id: 11, index: 1, name: 'Part 2', type: 'model_part' as const, isSplittable: false },
    ],
    instances: [{ id: 20, index: 0, printable: true }, { id: 21, index: 1, printable: true }],
  }],
};

function makeRuntime(): SlicerRuntime {
  return {
    deleteObjects: vi.fn(async () => ({ ok: true, objects: 0, deleted: 1 })),
    deleteVolumes: vi.fn(async () => ({ ok: true, objects: 1, deleted: 1 })),
    getModelStructure: vi.fn(async () => structure),
  } as unknown as SlicerRuntime;
}

function makeScene(withIndex: { objectIdx: number; volumeIdx: number; instanceIdx: number }[],
  volumeScoped: boolean,
  objectIndices: number[],
): SceneInteractionController {
  return {
    selectedVolumes: () => withIndex.map((buffer) => ({ buffer })),
    isVolumeScopedSelection: () => volumeScoped,
    selectedObjectIndices: () => objectIndices,
  } as unknown as SceneInteractionController;
}

describe('deleteSelection', () => {
  beforeEach(() => {
    useSlicerStore.setState({ status: 'done', resultExported: true, error: 'stale', layers: 40 });
    useSettingsStore.setState({ modelLoaded: true, modelRevision: 3 });
  });

  it('deletes only the selected parts when the selection is part-scoped', async () => {
    const runtime = makeRuntime();
    const scene = makeScene([
      { objectIdx: 0, volumeIdx: 1, instanceIdx: 0 },
      { objectIdx: 0, volumeIdx: 1, instanceIdx: 1 },
    ], true, [0]);
    const r = await deleteSelection(runtime, scene);
    expect(r).toEqual({ ok: true });
    // Both selected volumes share volume id 11 (a volume is shared across instances).
    expect(runtime.deleteVolumes).toHaveBeenCalledWith([11]);
    expect(runtime.deleteObjects).not.toHaveBeenCalled();
    expect(useSlicerStore.getState().status).toBe('idle');
  });

  it('deletes whole objects when the selection is not part-scoped', async () => {
    const runtime = makeRuntime();
    const scene = makeScene([{ objectIdx: 0, volumeIdx: 0, instanceIdx: 0 }], false, [0]);
    const r = await deleteSelection(runtime, scene);
    expect(r).toEqual({ ok: true });
    expect(runtime.deleteObjects).toHaveBeenCalledWith([1]);
    expect(runtime.deleteVolumes).not.toHaveBeenCalled();
  });

  it('no-ops on an empty selection', async () => {
    const runtime = makeRuntime();
    const scene = makeScene([], false, []);
    const r = await deleteSelection(runtime, scene);
    expect(r).toEqual({ ok: true });
    expect(runtime.deleteObjects).not.toHaveBeenCalled();
    expect(runtime.deleteVolumes).not.toHaveBeenCalled();
  });

  it('flips modelLoaded off when the delete empties the plate', async () => {
    const runtime = makeRuntime();
    // deleteObjects returns objects: 0 for the emptied plate.
    const scene = makeScene([{ objectIdx: 0, volumeIdx: 0, instanceIdx: 0 }], false, [0]);
    await deleteSelection(runtime, scene);
    expect(useSettingsStore.getState().modelLoaded).toBe(false);
  });

  it('records a failed delete (e.g. last-solid-part guard)', async () => {
    const runtime = makeRuntime();
    (runtime.deleteVolumes as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      { ok: false, error: 'deleting the last solid part is not allowed' },
    );
    const scene = makeScene([{ objectIdx: 0, volumeIdx: 0, instanceIdx: 0 }, { objectIdx: 0, volumeIdx: 1, instanceIdx: 0 }], true, [0]);
    const r = await deleteSelection(runtime, scene);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('last solid part');
    expect(useSlicerStore.getState().error).toContain('last solid part');
  });

  it('fails closed when the selection no longer maps to the model', async () => {
    const runtime = makeRuntime();
    const scene = makeScene([{ objectIdx: 9, volumeIdx: 9, instanceIdx: 0 }], true, [9]);
    const r = await deleteSelection(runtime, scene);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no longer matches');
    expect(runtime.deleteVolumes).not.toHaveBeenCalled();
  });
});
