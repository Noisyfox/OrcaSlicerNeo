import type { PlatformCapabilities } from '@orca/platform-contract';
import type { PlateSessionSnapshot } from '@slicer/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePlateSessionStore } from '../../stores/usePlateSessionStore';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { applyPrimeTowerMoveMutation, selectPlateSessionAndClearSelection } from './plateSessionActions';

const plateA: PlateSessionSnapshot = {
  ok: true,
  version: 1,
  currentPlateId: 'a',
  plates: [
    { plateId: 'a', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1', instanceIds: [1], valid: true },
    { plateId: 'b', displayIndex: 1, origin: [264, 0, 0], name: 'Plate 2', instanceIds: [2], valid: true },
  ],
  inputRevisions: { a: 1, b: 1 },
};

const plateB = { ...plateA, currentPlateId: 'b' };

function platformFor(result: unknown): PlatformCapabilities {
  return { runtime: { selectPlate: vi.fn(async () => result) } } as unknown as PlatformCapabilities;
}

describe('plate selection actions', () => {
  afterEach(() => {
    usePlateSessionStore.getState().reset();
    useSlicerStore.getState().clearPlateResults();
  });

  it('clears selection only after an authoritative switch succeeds and records plate context', async () => {
    usePlateSessionStore.getState().setSnapshot(plateA);
    const clearSelection = vi.fn();
    const recordHistoryContext = vi.fn(async () => ({ dirty: false }));
    const platform = platformFor(plateB);
    (platform.runtime as unknown as { recordHistoryContext: typeof recordHistoryContext }).recordHistoryContext = recordHistoryContext;

    await expect(selectPlateSessionAndClearSelection(platform, 'b', clearSelection)).resolves.toBe(true);

    expect(clearSelection).toHaveBeenCalledOnce();
    expect(usePlateSessionStore.getState().snapshot?.currentPlateId).toBe('b');
    expect(recordHistoryContext).toHaveBeenCalledWith('Active Plate', expect.objectContaining({ activePlateId: 'b' }));
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
      currentPlateId: 'a', inputRevisions: { a: 2, b: 1 },
      plates: [{ plateId: 'a' }, { plateId: 'b' }],
    });
    expect(cancel).not.toHaveBeenCalled();
  });
});
