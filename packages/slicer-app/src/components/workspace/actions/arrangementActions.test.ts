import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformCapabilities } from '@orca/platform-contract';
import type { ArrangementRequest, ArrangementResult } from '@slicer/client';
import { arrangeModels, cancelArrangement } from './arrangementActions';
import { useArrangementStore } from '@/stores/useArrangementStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { useProjectStore } from '@/stores/useProjectStore';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';

const scene = { owner: 'none', closeGizmo: vi.fn(), selectedVolumes: () => [], selectionMode: 'object', gizmo: null } as unknown as SceneInteractionController;
afterEach(() => { useArrangementStore.setState({ active: false, result: null }); usePlateSessionStore.getState().reset(); });

describe('arrangement action admission and publication', () => {
  it('keeps a concurrent slice intact while computing and releases the editing fence on cancel', async () => {
    let finish!: (result: ArrangementResult) => void;
    const arrange = vi.fn((_request: ArrangementRequest) => new Promise<ArrangementResult>(resolve => { finish = resolve; }));
    const cancelSlice = vi.fn(), getHistoryStatus = vi.fn();
    const platform = { preferences: { load: async () => ({ version: 1, selectedProfiles: {}, ui: {}, arrangement: {
      byLayer: { distance: 12, rotate: false }, byObject: { distance: 25, rotate: true }, multipleMaterials: false, avoidCalibration: true,
    } }) }, runtime: { arrange, cancel: cancelSlice, getHistoryStatus,
      getRuntimeExecutionState: () => ({ threaded: true, serialSliceActive: false, sliceActive: true }),
      cancelArrangement: vi.fn(async () => ({ ok: true })),
    } } as unknown as PlatformCapabilities;
    useSettingsStore.getState().setValue('print_sequence', 'by object');
    useArrangementStore.setState({ alignY: true });
    const task = arrangeModels(platform, scene, 'all');
    await vi.waitFor(() => expect(arrange).toHaveBeenCalledOnce());
    expect(arrange.mock.calls[0]?.[0]).toMatchObject({ scope: 'all', distance: 25, rotate: true, alignY: false, multipleMaterials: false });
    expect(useArrangementStore.getState()).toMatchObject({ active: true, cancellable: true });
    expect(useProjectStore.getState().projectMutationPendingCount).toBe(1);
    expect(cancelSlice).not.toHaveBeenCalled();
    await cancelArrangement(platform);
    expect(platform.runtime.cancelArrangement).toHaveBeenCalledOnce();
    expect(useArrangementStore.getState().active).toBe(true);
    finish({ ok: true, cancelled: true, changed: false, placed: 0, unplaced: [], plateLimitReached: false });
    await task;
    expect(useArrangementStore.getState()).toMatchObject({ active: false, result: { cancelled: true } });
    expect(useProjectStore.getState().projectMutationPendingCount).toBe(0);
    expect(cancelSlice).not.toHaveBeenCalled(); expect(getHistoryStatus).not.toHaveBeenCalled();
  });

  it('rejects serial slicing and locked current plates before launching a task', async () => {
    const arrange = vi.fn();
    const platform = { runtime: { arrange, getRuntimeExecutionState: () => ({ threaded: false, serialSliceActive: true }) } } as unknown as PlatformCapabilities;
    await arrangeModels(platform, scene, 'all');
    expect(arrange).not.toHaveBeenCalled();
    platform.runtime.getRuntimeExecutionState = () => ({ threaded: true, serialSliceActive: false, sliceActive: false, serialTerminalEpoch: '0' });
    usePlateSessionStore.getState().setSnapshot({ ok: true, version: 1, currentPlateId: 'a', instances: [], plates: [
      { plateId: 'a', displayIndex: 0, origin: [0,0,0], name: 'A', locked: true, instanceIds: [], valid: true },
    ] });
    await arrangeModels(platform, scene, 'current');
    expect(arrange).not.toHaveBeenCalled();
  });
});
