import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformCapabilities } from '@orca/platform-contract';
import type { ArrangementRequest, ArrangementResult } from '@slicer/client';
import { arrangeModels } from './arrangementActions';
import { useArrangementStore } from '@/stores/useArrangementStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useNotificationStore } from '@/stores/useNotificationStore';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';

const scene = { owner: 'none', closeGizmo: vi.fn(), selectedVolumes: () => [], selectionMode: 'object', gizmo: null } as unknown as SceneInteractionController;
afterEach(() => { useArrangementStore.setState({ active: false }); usePlateSessionStore.getState().reset(); });

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
    expect(useNotificationStore.getState().notifications).toMatchObject([{ source: 'operation', key: 'arrangement', progress: { value: 0 } }]);
    expect(useProjectStore.getState().projectMutationPendingCount).toBe(1);
    expect(cancelSlice).not.toHaveBeenCalled();
    await useNotificationStore.getState().notifications[0].actions[0].onClick();
    expect(platform.runtime.cancelArrangement).toHaveBeenCalledOnce();
    expect(useNotificationStore.getState().notifications[0].actions).toMatchObject([{ label: 'Cancelling…', disabled: true }]);
    await useNotificationStore.getState().notifications[0].actions[0].onClick();
    expect(platform.runtime.cancelArrangement).toHaveBeenCalledOnce();
    expect(useArrangementStore.getState().active).toBe(true);
    finish({ ok: true, cancelled: true, changed: false, placed: 0, unplaced: [], plateLimitReached: false });
    await task;
    expect(useArrangementStore.getState()).toMatchObject({ active: false });
    expect(useNotificationStore.getState().notifications).toMatchObject([{ title: 'Arrangement cancelled', progress: null, actions: [], dismissible: true }]);
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

  it.each([true, false])('owns cancellation availability and retry state for threaded=%s', async threaded => {
    let finish!: (result: ArrangementResult) => void;
    const arrange = vi.fn(() => new Promise<ArrangementResult>(resolve => { finish = resolve; }));
    const cancelArrangement = vi.fn(async () => ({ ok: false, error: 'Could not cancel yet' }));
    const platform = { preferences: { load: async () => ({}) }, runtime: { arrange, cancelArrangement,
      getRuntimeExecutionState: () => ({ threaded, serialSliceActive: false }),
    } } as unknown as PlatformCapabilities;
    const task = arrangeModels(platform, scene, 'all');
    await vi.waitFor(() => expect(arrange).toHaveBeenCalledOnce());
    const notification = useNotificationStore.getState().notifications[0];
    expect(notification.actions).toHaveLength(threaded ? 1 : 0);
    if (threaded) {
      await notification.actions[0].onClick();
      expect(useNotificationStore.getState().notifications[0]).toMatchObject({ message: 'Could not cancel yet',
        actions: [{ label: 'Cancel', disabled: false }] });
      expect(useArrangementStore.getState().cancelling).toBe(false);
    }
    finish({ ok: true, cancelled: false, changed: false, placed: 0, unplaced: [], plateLimitReached: false });
    await task;
  });

  it('does not let a retained old cancellation callback cancel a newer arrangement', async () => {
    let finish!: (result: ArrangementResult) => void;
    const arrange = vi.fn(() => new Promise<ArrangementResult>(resolve => { finish = resolve; }));
    const cancelArrangement = vi.fn(async () => ({ ok: true }));
    const platform = { preferences: { load: async () => ({}) }, runtime: { arrange, cancelArrangement,
      getRuntimeExecutionState: () => ({ threaded: true, serialSliceActive: false }),
    } } as unknown as PlatformCapabilities;
    const result: ArrangementResult = { ok: true, cancelled: false, changed: false, placed: 0, unplaced: [], plateLimitReached: false };
    const first = arrangeModels(platform, scene, 'all');
    await vi.waitFor(() => expect(arrange).toHaveBeenCalledTimes(1));
    const oldCancel = useNotificationStore.getState().notifications[0].actions[0].onClick;
    finish(result); await first;
    const second = arrangeModels(platform, scene, 'all');
    await vi.waitFor(() => expect(arrange).toHaveBeenCalledTimes(2));
    await oldCancel();
    expect(cancelArrangement).not.toHaveBeenCalled();
    expect(useArrangementStore.getState().cancelling).toBe(false);
    finish(result); await second;
  });

  it.each([
    { result: { ok: true, cancelled: false, changed: false, placed: 7, plateLimitReached: true,
      unplaced: [{ instanceId: 1, reason: 'plate-limit' }, { instanceId: 2, reason: 'plate-limit' },
        { instanceId: 3, reason: 'non-printable' }, { instanceId: 4, reason: 'too-tall' }] } as ArrangementResult,
      title: 'Arrangement complete', severity: 'warning', messages: ['7 placed · 4 parked outside plates',
        'The 36-plate limit was reached.', '36-plate limit reached: 2', 'Marked non-printable: 1', 'Exceeds print height: 1'] },
    { result: { ok: true, cancelled: false, changed: false, placed: 3, plateLimitReached: false, unplaced: [] } as ArrangementResult,
      title: 'Arrangement complete', severity: 'info', messages: ['3 placed · 0 parked outside plates'] },
    { result: { ok: false, error: 'Native arrangement failed' } as ArrangementResult,
      title: 'Arrangement failed', severity: 'error', messages: ['Native arrangement failed'] },
    { result: new Error('Runtime disconnected'), title: 'Arrangement failed', severity: 'error', messages: ['Runtime disconnected'] },
  ])('publishes $title with $severity through the shared notification lifecycle', async ({ result, title, severity, messages }) => {
    const arrange = vi.fn(async (_request: ArrangementRequest, progress: (value: number, message: string) => void) => {
      progress(50, 'Packing models');
      expect(useNotificationStore.getState().notifications).toMatchObject([{ progress: { value: 50 }, message: 'Packing models' }]);
      if (result instanceof Error) throw result;
      return result;
    });
    const platform = { preferences: { load: async () => ({}) }, runtime: { arrange,
      getRuntimeExecutionState: () => ({ threaded: true, serialSliceActive: false }),
    } } as unknown as PlatformCapabilities;
    await arrangeModels(platform, scene, 'all');
    const cards = useNotificationStore.getState().notifications;
    expect(cards).toMatchObject([{ source: 'operation', key: 'arrangement', title, severity, progress: null }]);
    for (const message of messages) expect(cards[0].message).toContain(message);
    expect(useArrangementStore.getState().active).toBe(false);
  });
});
