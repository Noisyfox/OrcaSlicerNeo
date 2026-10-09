import { describe, expect, it, vi } from 'vitest';
import { completeSetupWizard, retrySetupWizardApplication } from './setupWizard';
import type { UserPreferences, UserPreferencesRepository } from '@orca/platform-contract';
import { updateUserPreferences } from '@orca/platform-contract';
import { createClient, createMockModule, MOCK_PROFILE_ACTIVATION } from '@slicer/client';

const initial: UserPreferences = { version: 1, rememberedBedTypes: {}, selectedProfiles: {},
  ui: { switchToDeviceAfterSend: true } };
async function fixture() {
  const module = createMockModule();
  const runtime = createClient(async () => module);
  await runtime.init(MOCK_PROFILE_ACTIVATION);
  await runtime.openSetupWizardCatalogue();
  let saved = structuredClone(initial);
  const events: string[] = [];
  const repository: UserPreferencesRepository = {
    load: vi.fn(async () => { events.push('load'); return structuredClone(saved); }),
    save: vi.fn(async value => { events.push('save'); saved = structuredClone(value); }),
  };
  const prepare = runtime.prepareProfileActivation.bind(runtime);
  runtime.prepareProfileActivation = vi.fn(async selection => { events.push('prepare'); return prepare(selection); });
  const apply = runtime.applyProfileActivation.bind(runtime);
  runtime.applyProfileActivation = vi.fn(async () => { events.push('apply'); return apply(); });
  return { module, runtime, repository, events, saved: () => saved };
}

describe('save-before-apply setup completion', () => {
  it('saves the prepared native result before publishing and preserves other preference writes', async () => {
    const f = await fixture();
    const concurrent = updateUserPreferences(f.repository, current => ({ ...current, selectedProfiles: { printer: 'remembered' } }));
    const result = await completeSetupWizard(f.runtime, f.repository, { ...MOCK_PROFILE_ACTIVATION, filaments: ['Retired PLA'] });
    await concurrent;
    expect(result.ok).toBe(true);
    expect(f.saved().profileActivation!.filaments).toEqual(['Retired PLA', 'Generic PLA @System']);
    expect(f.saved().selectedProfiles.printer).toBe('remembered');
    expect(f.events.indexOf('prepare')).toBeLessThan(f.events.lastIndexOf('save'));
    expect(f.events.lastIndexOf('save')).toBeLessThan(f.events.indexOf('apply'));
    if (!result.ok) throw new Error(result.error);
    expect(result.historyStatus.canUndo).toBe(false);
    expect(result.plateSession.ok).toBe(true);
  });

  it('loads queued target-specific rack and bed preferences before preparing, without an extra save', async () => {
    const f = await fixture();
    const racks = { Target: { version: 1 as const, slots: [{ preset: 'Generic PLA @System', colour: '#123456',
      native: { representative: '#123456', multiColour: '#123456 #ABCDEF', type: '0' } }] } };
    const pending = updateUserPreferences(f.repository, current => ({ ...current,
      rememberedFilamentRacks: racks, rememberedBedTypes: { Target: 'Engineering Plate' } }));
    const result = await completeSetupWizard(f.runtime, f.repository, MOCK_PROFILE_ACTIVATION);
    await pending;
    expect(result.ok).toBe(true);
    expect(f.runtime.prepareProfileActivation).toHaveBeenCalledWith({ activation: MOCK_PROFILE_ACTIVATION,
      rememberedFilamentRacks: racks, rememberedBedTypes: { Target: 'Engineering Plate' } });
    expect(f.repository.save).toHaveBeenCalledTimes(2);
  });

  it('preference read failure prevents preparation and apply', async () => {
    const f = await fixture();
    f.repository.load = vi.fn(async () => { throw new Error('preferences unreadable'); });
    expect(await completeSetupWizard(f.runtime, f.repository, MOCK_PROFILE_ACTIVATION))
      .toEqual({ ok: false, phase: 'prepare', error: 'preferences unreadable' });
    expect(f.runtime.prepareProfileActivation).not.toHaveBeenCalled();
    expect(f.repository.save).not.toHaveBeenCalled();
    expect(f.runtime.applyProfileActivation).not.toHaveBeenCalled();
  });

  it('rejects overlapping completion/retry while saving so another selection cannot replace the prepared candidate', async () => {
    const f = await fixture();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const saving = new Promise<void>(resolve => { started = resolve; });
    const save = f.repository.save;
    f.repository.save = async value => { started(); await pending; return save(value); };
    const completing = completeSetupWizard(f.runtime, f.repository, MOCK_PROFILE_ACTIVATION);
    await saving;
    expect(await completeSetupWizard(f.runtime, f.repository, { models: [], filaments: [] }))
      .toMatchObject({ ok: false, phase: 'prepare', error: 'setup completion is already in progress' });
    expect(await retrySetupWizardApplication(f.runtime)).toMatchObject({ ok: false, phase: 'apply' });
    expect(f.runtime.prepareProfileActivation).toHaveBeenCalledTimes(1);
    expect(f.runtime.applyProfileActivation).not.toHaveBeenCalled();
    release(); expect((await completing).ok).toBe(true);
  });

  it('preparation failure prevents saving and applying', async () => {
    const f = await fixture();
    const result = await completeSetupWizard(f.runtime, f.repository, { models: [], filaments: [] });
    expect(result).toMatchObject({ ok: false, phase: 'prepare' });
    expect(f.repository.save).not.toHaveBeenCalled(); expect(f.runtime.applyProfileActivation).not.toHaveBeenCalled();
  });

  it('save failure preserves the live session and filesystem links', async () => {
    const f = await fixture();
    const before = { profiles: await f.runtime.getProfileSnapshot(), history: await f.runtime.getHistoryStatus(), system: f.module.FS.readdir('/system') };
    f.repository.save = vi.fn(async () => { throw new Error('disk unavailable'); });
    expect(await completeSetupWizard(f.runtime, f.repository, MOCK_PROFILE_ACTIVATION)).toMatchObject({ ok: false, phase: 'save', error: 'disk unavailable' });
    expect(f.runtime.applyProfileActivation).not.toHaveBeenCalled();
    expect({ profiles: await f.runtime.getProfileSnapshot(), history: await f.runtime.getHistoryStatus(), system: f.module.FS.readdir('/system') }).toEqual(before);
  });

  it('application failure retains the saved record and retries without another save', async () => {
    const f = await fixture();
    const before = await f.runtime.getHistoryStatus();
    const apply = f.runtime.applyProfileActivation;
    f.runtime.applyProfileActivation = vi.fn().mockResolvedValueOnce({ ok: false, error: 'publication rejected' }).mockImplementation(apply);
    expect(await completeSetupWizard(f.runtime, f.repository, MOCK_PROFILE_ACTIVATION)).toEqual({ ok: false, phase: 'apply', error: 'publication rejected' });
    expect(f.saved().profileActivation).toEqual(MOCK_PROFILE_ACTIVATION);
    expect(await f.runtime.getHistoryStatus()).toEqual(before);
    expect((await retrySetupWizardApplication(f.runtime)).ok).toBe(true);
    expect(f.repository.save).toHaveBeenCalledTimes(1);
  });
});
