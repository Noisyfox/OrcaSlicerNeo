import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformCapabilities } from '@orca/platform-contract';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { commitOptionFieldChange } from './OptionField';
import { commitSharedConfigurationMutation, invalidateAfterSharedConfigurationMutation } from './configurationActions';

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

function runProjectHistoryTransaction<T>(
  _label: string,
  _category: 'project' | 'context',
  _before: unknown,
  mutationCallback: (transactionId: string) => Promise<T>,
  _after: unknown | (() => unknown | Promise<unknown>),
): Promise<{ result: T; status: never }> {
  return mutationCallback('tx-1').then((result) => ({ result, status: undefined as never }));
}

describe('commitSharedConfigurationMutation', () => {
  beforeEach(() => {
    useProjectStore.getState().reset();
    useSlicerStore.getState().clearPlateResults();
    useSlicerStore.setState({ error: null });
  });

  it('routes an option-field commit through the typed runtime before recording it', async () => {
    const mark = vi.fn(async () => mutation);
    const platform = { runtime: { markSharedConfigurationMutation: mark, runProjectHistoryTransaction } } as unknown as PlatformCapabilities;
    await commitOptionFieldChange(platform, 'layer_height', '0.3');
    expect(mark).toHaveBeenCalledOnce();
    expect(useSettingsStore.getState().values.layer_height).toBe('0.3');
    expect(useProjectStore.getState().plateInputRevisions).toEqual({ 'plate-1': 9 });
  });

  it('records the authoritative runtime transaction, including its revisions', async () => {
    const mark = vi.fn(async () => mutation);
    const platform = { runtime: { markSharedConfigurationMutation: mark, runProjectHistoryTransaction } } as unknown as PlatformCapabilities;
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
    const platform = { runtime: { markSharedConfigurationMutation: mark, runProjectHistoryTransaction } } as unknown as PlatformCapabilities;
    await expect(commitSharedConfigurationMutation(platform)).rejects.toThrow('bridge rejected');
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, dirtyReasons: [], plateInputRevisions: {} });
    expect(useSlicerStore.getState().error).toBe('bridge rejected');
  });

  it('keeps the native effective correction and plate-local transaction', async () => {
    const setOverride = vi.fn(async () => ({
      ok: true as const,
      overlay: { project: {}, objects: {}, parts: {}, plates: { 'plate-2': { wipe_tower_x: '0' } } },
      configurationStatus: { state: 'ready' as const, corrections: [{ key: 'wipe_tower_x', requested: 'invalid', effective: '0' }], warnings: [], errors: [] },
      plateSession: { ...mutation, currentPlateId: 'plate-2', inputRevisions: { 'plate-1': 9, 'plate-2': 10 }, affectedPlateIds: ['plate-2'], dirtyReasons: ['prime-tower-position'] },
    }));
    const platform = { runtime: { setProjectConfigOverride: setOverride, runProjectHistoryTransaction } } as unknown as PlatformCapabilities;
    await commitOptionFieldChange(platform, 'wipe_tower_x', 'invalid', { scope: 'plate', id: 'plate-2' });
    expect(setOverride).toHaveBeenCalledWith({ scope: 'plate', id: 'plate-2' }, 'wipe_tower_x', 'invalid');
    expect(useSettingsStore.getState().overlay.plates['plate-2']?.wipe_tower_x).toBe('0');
    expect(useProjectStore.getState().plateInputRevisions).toEqual({ 'plate-1': 9, 'plate-2': 10 });
    expect(useProjectStore.getState().dirtyReasons).toContain('prime-tower-position');
  });

  it('invalidates only the native affected plate for a scoped override', async () => {
    const result = { ok: true, objects: 1, layers: 1, toolpath: {}, metadata: {} } as any;
    const slicer = useSlicerStore.getState();
    slicer.setPlateResult({ plateId: 'plate-1', inputRevision: 1 }, result);
    slicer.setPlateResult({ plateId: 'plate-2', inputRevision: 1 }, result);
    const setOverride = vi.fn(async () => ({
      ok: true as const,
      overlay: { project: {}, objects: {}, parts: {}, plates: { 'plate-2': { wipe_tower_x: '15' } } },
      plateSession: { ...mutation, currentPlateId: 'plate-2', inputRevisions: { 'plate-1': 9, 'plate-2': 10 }, affectedPlateIds: ['plate-2'], dirtyReasons: ['prime-tower-position'] },
    }));
    const platform = { runtime: { setProjectConfigOverride: setOverride, runProjectHistoryTransaction } } as unknown as PlatformCapabilities;
    await commitOptionFieldChange(platform, 'wipe_tower_x', '15', { scope: 'plate', id: 'plate-2' });
    expect(Object.keys(useSlicerStore.getState().plateResults)).toEqual(['plate-1']);
  });

  it('treats an explicit empty native affected set as a scoped no-op', () => {
    const result = { ok: true, objects: 1, layers: 1, toolpath: {}, metadata: {} } as any;
    const slicer = useSlicerStore.getState();
    slicer.setPlateResult({ plateId: 'plate-1', inputRevision: 1 }, result);
    slicer.setPlateResult({ plateId: 'plate-2', inputRevision: 1 }, result);

    invalidateAfterSharedConfigurationMutation([]);

    expect(Object.keys(useSlicerStore.getState().plateResults)).toEqual(['plate-1', 'plate-2']);
  });

  it('publishes native warnings without converting a successful commit into a failure', async () => {
    const setOverride = vi.fn()
      .mockResolvedValueOnce({
        ok: true as const,
        overlay: { project: { prime_tower_width: '20' }, objects: {}, parts: {}, plates: {} },
        configurationStatus: { state: 'ready' as const, corrections: [], warnings: ['width was clamped'], errors: [] },
        plateSession: mutation,
      })
      .mockResolvedValueOnce({
        ok: true as const,
        overlay: { project: { prime_tower_width: '21' }, objects: {}, parts: {}, plates: {} },
        configurationStatus: { state: 'ready' as const, corrections: [], warnings: [], errors: [] },
        plateSession: mutation,
      });
    const platform = { runtime: { setProjectConfigOverride: setOverride, runProjectHistoryTransaction } } as unknown as PlatformCapabilities;

    await expect(commitOptionFieldChange(platform, 'prime_tower_width', '20')).resolves.toBeUndefined();
    expect(useSettingsStore.getState().overlay.project.prime_tower_width).toBe('20');
    expect(useProjectStore.getState().dirty).toBe(true);
    expect(useSlicerStore.getState().error).toBe('[Warning] width was clamped');

    await commitOptionFieldChange(platform, 'prime_tower_width', '21');
    expect(useSettingsStore.getState().overlay.project.prime_tower_width).toBe('21');
    expect(useSlicerStore.getState().error).toBe('[Warning] width was clamped');
  });
});
