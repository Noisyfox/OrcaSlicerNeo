import type { PlatformCapabilities } from '@orca/platform-contract';
import type { PlateSessionSnapshot } from '@slicer/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePlateSessionStore } from '../../stores/usePlateSessionStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { emptyProjectConfigOverlay, useSettingsStore } from '../../stores/useSettingsStore';
import { applyPlateSessionResponse, applyPrimeTowerMoveMutation, selectPlateSessionAndClearSelection } from './plateSessionActions';

const plateA: PlateSessionSnapshot = {
  instances: [],
  ok: true,
  version: 1,
  currentPlateId: 'a',
  plates: [
    { plateId: 'a', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1', instanceIds: [1], valid: true },
    { plateId: 'b', displayIndex: 1, origin: [264, 0, 0], name: 'Plate 2', instanceIds: [2], valid: true },
  ],
  inputRevisions: { a: 1, b: 1 },
};

const plateB = { ok: true as const, version: 1 as const, currentPlateId: 'b' };

function platformFor(result: unknown): PlatformCapabilities {
  return { runtime: { selectPlate: vi.fn(async () => result) } } as unknown as PlatformCapabilities;
}

describe('plate selection actions', () => {
  afterEach(() => {
    usePlateSessionStore.getState().reset();
    useProjectStore.getState().reset();
    useSlicerStore.getState().clearPlateResults();
    useSettingsStore.getState().setOverlay(emptyProjectConfigOverlay());
  });

  it('clears selection after an authoritative switch without touching history', async () => {
    usePlateSessionStore.getState().setSnapshot(plateA);
    const clearSelection = vi.fn();
    const getPlateSessionSnapshot = vi.fn();
    useProjectStore.getState().setProject({ hasContent: true, dirty: false, dirtyReasons: [] });
    const platform = platformFor(plateB);
    (platform.runtime as unknown as { getPlateSessionSnapshot: typeof getPlateSessionSnapshot }).getPlateSessionSnapshot = getPlateSessionSnapshot;

    await expect(selectPlateSessionAndClearSelection(platform, 'b', clearSelection)).resolves.toBe(true);

    expect(clearSelection).toHaveBeenCalledOnce();
    expect(usePlateSessionStore.getState().snapshot).toMatchObject({
      instances: [],
      currentPlateId: 'b', plates: plateA.plates, inputRevisions: plateA.inputRevisions,
    });
    expect(getPlateSessionSnapshot).not.toHaveBeenCalled();
    expect(useProjectStore.getState()).toMatchObject({ hasContent: true, dirty: false, dirtyReasons: [] });
  });

  it('clears locally without a runtime call for the current plate, and preserves selection when switching fails', async () => {
    usePlateSessionStore.getState().setSnapshot(plateA);
    const clearSelection = vi.fn();
    const currentRuntime = platformFor(plateA).runtime as unknown as { selectPlate: ReturnType<typeof vi.fn> };

    await expect(selectPlateSessionAndClearSelection({ runtime: currentRuntime } as unknown as PlatformCapabilities, 'a', clearSelection)).resolves.toBe(false);
    expect(currentRuntime.selectPlate).not.toHaveBeenCalled();
    expect(clearSelection).toHaveBeenCalledOnce();

    await expect(selectPlateSessionAndClearSelection(platformFor({ ok: false, error: 'rejected' }), 'b', clearSelection)).resolves.toBe(false);

    expect(clearSelection).toHaveBeenCalledOnce();
    expect(usePlateSessionStore.getState().snapshot?.currentPlateId).toBe('a');
  });

  it('patches only the moved Prime Tower plate revision instead of replacing the complete session', () => {
    usePlateSessionStore.getState().setSnapshot(plateA);
    const cancel = vi.fn(async () => undefined);

    expect(applyPrimeTowerMoveMutation({ runtime: { cancel } } as unknown as PlatformCapabilities, {
      kind: 'move', plateId: 'a', historyEntryDelta: 1, revisionBefore: 1, revisionAfter: 2,
      dirty: true, affectedPlateIds: ['a'], position: { x: 30, y: 40 },
      footprint: { minX: 30, maxX: 50, minY: 40, maxY: 60 },
    })).toBe(true);

    expect(usePlateSessionStore.getState().snapshot).toMatchObject({
      instances: [],
      currentPlateId: 'a', inputRevisions: { a: 2, b: 1 },
      plates: [{ plateId: 'a' }, { plateId: 'b' }],
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('publishes the authoritative overlay carried by a structural plate receipt', () => {
    usePlateSessionStore.getState().setSnapshot(plateA);
    const projectConfigOverlay = {
      project: { wipe_tower_x: '15,15,15', wipe_tower_y: '220,220,220' },
      objects: {}, parts: {}, plates: {},
    };
    const result = {
      ...plateA,
      instanceTransforms: [],
      dirtyReasons: ['plate-structure'],
      projectConfigOverlay,
    };

    expect(applyPlateSessionResponse({ runtime: {} } as unknown as PlatformCapabilities, result)).toBe(true);
    expect(useSettingsStore.getState().overlay).toEqual(projectConfigOverlay);
  });
});
