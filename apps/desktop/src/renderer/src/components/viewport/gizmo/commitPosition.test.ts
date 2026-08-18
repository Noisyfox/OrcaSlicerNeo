// apps/desktop/src/renderer/src/components/viewport/gizmo/commitPosition.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { commitPosition, type OffsetClient } from './commitPosition';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { GLVolume, glVolumeCollection } from '../GLVolume';

function makeClient(ok: boolean, error?: string): OffsetClient {
  return {
    setInstanceOffset: vi.fn(async () => (ok ? { ok: true } : { ok: false, error })),
  } as unknown as OffsetClient;
}

describe('commitPosition', () => {
  beforeEach(() => {
    useSettingsStore.setState({ positions: {}, initialPositions: {}, objectMinZ: {} });
    glVolumeCollection.clear();
  });

  it('keeps the edit local until the slice synchronization boundary', async () => {
    useSettingsStore.getState().setObjectOffsets({ 0: [0, 0, 0] }, { 0: [0, 0, 0] }, {});
    glVolumeCollection.replace([new GLVolume({
      objectIdx: 0, volumeIdx: 0, instanceIdx: 0,
      positions: new Float32Array([0, 0, 0]), vertexCount: 1,
      indices: new Uint32Array(), indexCount: 0, offset: [0, 0, 0],
      instanceTransform: { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] },
      volumeTransform: { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] },
    })]);
    const client = makeClient(true);
    const onError = vi.fn();
    const ok = await commitPosition(client, 0, 0, [10, 20, 30], [0, 0, 0], onError);
    expect(ok).toBe(true);
    expect(client.setInstanceOffset).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().positions[0]).toEqual([10, 20, 30]);
    expect(glVolumeCollection.volumes[0].instanceTransform.offset).toEqual([10, 20, 30]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('rejects an edit whose ModelInstance has left the local collection', async () => {
    // Seed ≠ revertPos ([5,5,5]): if the revert were skipped, positions
    // would stay at the seed and the assertion below would fail.
    useSettingsStore.getState().setObjectOffsets({ 0: [1, 1, 1] }, { 0: [1, 1, 1] }, {});
    const client = makeClient(false, 'boom');
    const onError = vi.fn();
    const ok = await commitPosition(client, 0, 0, [10, 20, 30], [5, 5, 5], onError);
    expect(ok).toBe(false);
    expect(useSettingsStore.getState().positions[0]).toEqual([5, 5, 5]);
    expect(onError).toHaveBeenCalledWith('selected ModelInstance no longer exists');
  });
});
