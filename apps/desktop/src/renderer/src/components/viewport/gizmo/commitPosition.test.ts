// apps/desktop/src/renderer/src/components/viewport/gizmo/commitPosition.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { commitPosition, type OffsetClient } from './commitPosition';
import { useSettingsStore } from '../../../stores/useSettingsStore';

function makeClient(ok: boolean, error?: string): OffsetClient {
  return {
    setInstanceOffset: vi.fn(async () => (ok ? { ok: true } : { ok: false, error })),
  } as unknown as OffsetClient;
}

describe('commitPosition', () => {
  beforeEach(() => {
    useSettingsStore.setState({ positions: {}, initialPositions: {}, objectMinZ: {} });
  });

  it('calls the bridge with instance 0 and updates the store on success', async () => {
    useSettingsStore.getState().setObjectOffsets({ 0: [0, 0, 0] }, { 0: [0, 0, 0] }, {});
    const client = makeClient(true);
    const onError = vi.fn();
    const ok = await commitPosition(client, 0, [10, 20, 30], [0, 0, 0], onError);
    expect(ok).toBe(true);
    expect(client.setInstanceOffset).toHaveBeenCalledWith(0, 0, 10, 20, 30);
    expect(useSettingsStore.getState().positions[0]).toEqual([10, 20, 30]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reverts the store to revertPos and reports the error on failure', async () => {
    useSettingsStore.getState().setObjectOffsets({ 0: [5, 5, 5] }, { 0: [5, 5, 5] }, {});
    const client = makeClient(false, 'boom');
    const onError = vi.fn();
    const ok = await commitPosition(client, 0, [10, 20, 30], [5, 5, 5], onError);
    expect(ok).toBe(false);
    expect(useSettingsStore.getState().positions[0]).toEqual([5, 5, 5]);
    expect(onError).toHaveBeenCalledWith('boom');
  });
});
