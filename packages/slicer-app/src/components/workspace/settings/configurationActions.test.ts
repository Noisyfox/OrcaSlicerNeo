import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformCapabilities } from '@orca/platform-contract';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import { commitOptionFieldChange } from './OptionField';
import { commitSharedConfigurationMutation } from './configurationActions';

const mutation = {
  ok: true as const,
  version: 1 as const,
  currentPlateId: 'plate-1',
  plates: [{ plateId: 'plate-1', displayIndex: 0, origin: [0, 0, 0] as [number, number, number], name: 'Plate 1' }],
  instanceTransforms: [],
  inputRevisions: { 'plate-1': 9 },
  affectedPlateIdsBefore: ['plate-1'],
  affectedPlateIdsAfter: ['plate-1'],
  affectedPlateIds: ['plate-1'],
  dirtyReasons: ['shared-configuration'],
};

describe('commitSharedConfigurationMutation', () => {
  beforeEach(() => useProjectStore.getState().reset());

  it('routes an option-field commit through the typed runtime before recording it', async () => {
    const mark = vi.fn(async () => mutation);
    const platform = { runtime: { markSharedConfigurationMutation: mark } } as unknown as PlatformCapabilities;
    await commitOptionFieldChange(platform, 'layer_height', '0.3');
    expect(mark).toHaveBeenCalledOnce();
    expect(useSettingsStore.getState().values.layer_height).toBe('0.3');
    expect(useProjectStore.getState().plateInputRevisions).toEqual({ 'plate-1': 9 });
  });

  it('records the authoritative runtime transaction, including its revisions', async () => {
    const mark = vi.fn(async () => mutation);
    const platform = { runtime: { markSharedConfigurationMutation: mark } } as unknown as PlatformCapabilities;
    await expect(commitSharedConfigurationMutation(platform)).resolves.toBe(mutation);
    expect(mark).toHaveBeenCalledOnce();
    expect(useProjectStore.getState()).toMatchObject({
      dirty: true,
      dirtyReasons: ['shared-configuration'],
      plateInputRevisions: { 'plate-1': 9 },
    });
  });

  it('surfaces a rejected bridge transaction without dirtying the store', async () => {
    const mark = vi.fn(async () => ({ ok: false as const, error: 'bridge rejected' }));
    const platform = { runtime: { markSharedConfigurationMutation: mark } } as unknown as PlatformCapabilities;
    await expect(commitSharedConfigurationMutation(platform)).rejects.toThrow('bridge rejected');
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, dirtyReasons: [], plateInputRevisions: {} });
  });
});
