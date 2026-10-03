import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_USER_PREFERENCES, normalizeArrangementPreferences,
  type UserPreferences, type UserPreferencesRepository,
} from '@orca/platform-contract';
import {
  loadArrangementPreferences, resetArrangementPreferences, setArrangementAlignY,
  synchronizeArrangementContext, updateArrangementPreferences, useArrangementStore,
} from './useArrangementStore';

function repository(initial: UserPreferences = DEFAULT_USER_PREFERENCES) {
  let saved = structuredClone(initial);
  return {
    load: vi.fn(async () => structuredClone(saved)),
    save: vi.fn(async (value: UserPreferences) => { saved = structuredClone(value); }),
  } satisfies UserPreferencesRepository;
}

beforeEach(() => {
  useArrangementStore.setState({ preferences: normalizeArrangementPreferences(null), ready: false,
    mode: 'byLayer', printer: null, printerStructure: '', alignY: false });
});

describe('arrangement preferences', () => {
  it('loads once per host repository and applies persisted rotation before enabling settings', async () => {
    const repo = repository({ ...DEFAULT_USER_PREFERENCES, arrangement: {
      ...normalizeArrangementPreferences(null), byLayer: { distance: 125, rotate: true },
    } });
    synchronizeArrangementContext('Printer', 'i3', 'by layer');
    expect(useArrangementStore.getState().alignY).toBe(true);
    const first = loadArrangementPreferences(repo);
    expect(loadArrangementPreferences(repo)).toBe(first);
    expect(useArrangementStore.getState().ready).toBe(false);
    await first;
    expect(repo.load).toHaveBeenCalledOnce();
    expect(useArrangementStore.getState()).toMatchObject({ ready: true, alignY: false,
      preferences: { byLayer: { distance: 125, rotate: true } } });
  });

  it('resets only the current print mode and shared options, and re-derives alignment', async () => {
    const repo = repository();
    await loadArrangementPreferences(repo);
    synchronizeArrangementContext('I3', 'i3', 'by object');
    await updateArrangementPreferences(repo, { byLayer: { distance: 132.5, rotate: true },
      byObject: { distance: 8, rotate: true }, multipleMaterials: false, avoidCalibration: false });
    expect(useArrangementStore.getState().alignY).toBe(false);
    await resetArrangementPreferences(repo, 'byObject', 'i3');
    expect(useArrangementStore.getState()).toMatchObject({ alignY: true, preferences: {
      byLayer: { distance: 132.5, rotate: true }, byObject: { distance: 0, rotate: false },
      multipleMaterials: true, avoidCalibration: true,
    } });
    expect((await repo.load()).arrangement).toEqual(useArrangementStore.getState().preferences);
    expect(repo.save.mock.calls.at(-1)?.[0]).not.toHaveProperty('alignY');
  });

  it('enforces rotation exclusion on mode switches and printer changes without persisting Y alignment', async () => {
    const repo = repository();
    await loadArrangementPreferences(repo);
    synchronizeArrangementContext('First', 'i3', 'by layer');
    await updateArrangementPreferences(repo, { ...useArrangementStore.getState().preferences,
      byObject: { distance: 12, rotate: true } });
    expect(useArrangementStore.getState().alignY).toBe(true);
    synchronizeArrangementContext('First', 'i3', 'by object');
    expect(useArrangementStore.getState().alignY).toBe(false);
    setArrangementAlignY(true);
    expect(useArrangementStore.getState().alignY).toBe(false);
    synchronizeArrangementContext('Second', 'I3', 'by object');
    expect(useArrangementStore.getState().alignY).toBe(false);
    synchronizeArrangementContext('Third', 'I3', 'by layer');
    expect(useArrangementStore.getState().alignY).toBe(true);
    setArrangementAlignY(false);
    synchronizeArrangementContext('Third', 'I3', 'by layer');
    expect(useArrangementStore.getState().alignY).toBe(false);
    synchronizeArrangementContext('Fourth', 'corexy', 'by layer');
    expect(useArrangementStore.getState().alignY).toBe(false);
    expect(repo.save).toHaveBeenCalledOnce();
  });

  it('serializes rapid writes and preserves the latest unrelated host preferences', async () => {
    const repo = repository();
    await loadArrangementPreferences(repo);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const originalSave = repo.save.getMockImplementation()!;
    repo.save.mockImplementationOnce(async (value) => { await blocked; await originalSave(value); });
    const first = updateArrangementPreferences(repo, { ...useArrangementStore.getState().preferences,
      byLayer: { distance: 150, rotate: false } });
    const second = updateArrangementPreferences(repo, { ...useArrangementStore.getState().preferences,
      byObject: { distance: 23, rotate: true }, multipleMaterials: false });
    await vi.waitFor(() => expect(repo.save).toHaveBeenCalledOnce());
    expect(useArrangementStore.getState().preferences.byObject).toEqual({ distance: 23, rotate: true });
    release();
    await Promise.all([first, second]);
    expect((await repo.load()).arrangement).toMatchObject({ byLayer: { distance: 150, rotate: false },
      byObject: { distance: 23, rotate: true }, multipleMaterials: false });

    await repo.save({ ...(await repo.load()), selectedProfiles: { printer: 'Changed externally' }, ui: { sidebarWidth: 333, switchToDeviceAfterSend: true } });
    await resetArrangementPreferences(repo, 'byLayer', 'corexy');
    expect(await repo.load()).toMatchObject({ selectedProfiles: { printer: 'Changed externally' }, ui: { sidebarWidth: 333 },
      arrangement: { byLayer: { distance: 0, rotate: false }, byObject: { distance: 23, rotate: true } } });
  });

  it('allows defaults after a load failure and continues saving after a failed write', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const repo = repository();
      repo.load.mockRejectedValueOnce(new Error('load failed'));
      await loadArrangementPreferences(repo);
      expect(useArrangementStore.getState().ready).toBe(true);
      repo.save.mockRejectedValueOnce(new Error('save failed'));
      await updateArrangementPreferences(repo, { ...useArrangementStore.getState().preferences, multipleMaterials: false });
      await updateArrangementPreferences(repo, { ...useArrangementStore.getState().preferences, avoidCalibration: false });
      expect((await repo.load()).arrangement).toMatchObject({ multipleMaterials: false, avoidCalibration: false });
      expect(error).toHaveBeenCalledTimes(2);
    } finally { error.mockRestore(); }
  });
});
