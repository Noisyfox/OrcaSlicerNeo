import { describe, expect, it, vi } from 'vitest';
import { applyRememberedFilamentRackFromRepository, rememberedFilamentRack, rememberedRackFromSnapshot, persistRestoredSelections, publishRememberedFilamentRack, restoreBootstrapSession, restoreSelections, publishRememberedBedType, loadRememberedBedTypeFromRepository, seedRememberedBedType, configureProjectFlowPreferences, commitProjectFlow } from './preferences';
import type { UserPreferences, UserPreferencesRepository } from '@orca/platform-contract';
import type { ProfileSnapshot } from '@slicer/client';
import { createClient, createMockModule, MOCK_PROFILE_ACTIVATION } from '@slicer/client';

const prefs: UserPreferences = {
  version: 1,
  rememberedBedTypes: {}, selectedProfiles: { printer: 'P', print: 'Q' },
  ui: { switchToDeviceAfterSend: true },
};

function snapshot(printer: string, print: string, filament: string): ProfileSnapshot {
  return {
    ok: true,
    modifiedPresets: { printer: [], filament: [] },
    printerPicker: { basePrinter: 'Fixture printer', flows: [], items: [{ id: printer, label: printer, preset: printer }], selectedId: printer, variants: [], nozzleDiameters: [0.4], selectedVariant: '' },
    printers: [{ name: printer, label: printer, vendor: '', is_visible: true, is_project_embedded: false, is_user: false, is_default: false, vendor_id: '', model: '', variant: '', selected: true }],
    prints: [{ name: print, label: print, vendor: '', is_visible: true, is_project_embedded: false, is_user: false, is_default: false, vendor_id: '', model: '', variant: '', selected: true }],
    filamentCatalog: [{ name: filament, label: filament, vendor: '', is_visible: true, is_project_embedded: false, is_user: false, is_default: false, vendor_id: '', model: '', variant: '' }],
    printer: { name: printer, idx: 0 },
    print: { name: print, idx: 0 },
    bedType: { supportsSelection: true, defaultValue: 'Textured PEI Plate', choices: [{ value: 'Textured PEI Plate', label: 'Textured PEI Plate' }] },
  };
}

describe('selection restoration', () => {
  it('restores printer and process while leaving rack filament selection to the session', async () => {
    const initial = snapshot('default-printer', 'default-print', 'default-filament');
    const final = snapshot('P2', 'Q2', 'F2');
    const calls: Array<[string, string]> = [];
    const result = await restoreSelections({
      getProfileSnapshot: vi.fn(async () => initial),
      selectProfile: vi.fn(async (kind, name) => {
        calls.push([kind, name]);
        return final;
      }),
    }, prefs);

    expect(calls).toEqual([['printer', 'P'], ['print', 'Q']]);
    expect(result.snapshot).toBe(final);
    expect(result.preferences.selectedProfiles).toEqual({ printer: 'P2', print: 'Q2' });
  });

  it('uses the current snapshot candidate after a rejected saved name, then keeps later candidates current', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const initial = snapshot('engine-printer', 'engine-print', 'engine-filament');
    const afterPrinter = snapshot('fallback-printer', 'printer-print', 'printer-filament');
    const afterPrint = snapshot('fallback-printer', 'fallback-print', 'print-filament');
    const calls: Array<[string, string]> = [];
    const result = await restoreSelections({
      getProfileSnapshot: async () => initial,
      selectProfile: async (kind, name) => {
        calls.push([kind, name]);
        if (kind === 'printer' && name === 'P') return { error: 'not available' };
        if (kind === 'printer') return afterPrinter;
        if (kind === 'print' && name === 'Q') return { error: 'not available' };
        if (kind === 'print') return afterPrint;
        return afterPrint;
      },
    }, prefs);

    expect(calls).toEqual([
      ['printer', 'P'], ['printer', 'engine-printer'],
      ['print', 'Q'], ['print', 'printer-print'],
    ]);
    expect(result.snapshot).toBe(afterPrint);
    expect(result.preferences.selectedProfiles).toEqual({
      printer: 'fallback-printer', print: 'fallback-print',
    });
  });

  it('uses engine-selected candidates when preferences are absent', async () => {
    const initial = snapshot('engine-printer', 'engine-print', 'engine-filament');
    const final = snapshot('resolved-printer', 'resolved-print', 'resolved-filament');
    const calls: Array<[string, string]> = [];
    const result = await restoreSelections({
      getProfileSnapshot: async () => initial,
      selectProfile: async (kind, name) => {
        calls.push([kind, name]);
        return final;
      },
    }, { version: 1, rememberedBedTypes: {}, selectedProfiles: {}, ui: { switchToDeviceAfterSend: true } });

    expect(calls).toEqual([
      ['printer', 'engine-printer'],
      ['print', 'resolved-print'],
    ]);
    expect(result.preferences.selectedProfiles).toEqual({
      printer: 'resolved-printer', print: 'resolved-print',
    });
  });

  it('persists the resolved triple without failing the already-valid boot state on storage errors', async () => {
    const preferences = {
      version: 1 as const,
      rememberedBedTypes: {}, selectedProfiles: { printer: 'resolved-printer', print: 'resolved-print' },
      ui: { switchToDeviceAfterSend: true },
    };
    const repository = { load: vi.fn(async () => preferences), save: vi.fn(async () => {}) };
    await persistRestoredSelections(repository, preferences);
    expect(repository.save).toHaveBeenCalledWith(preferences);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    repository.save.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(persistRestoredSelections(repository, preferences)).resolves.toBeUndefined();
  });

  it('projects and namespaces the effective rack without duplicating slot 1 preferences', async () => {
    const snapshot = {
      ok: true as const,
      version: 1 as const,
      slots: [
        { logicalId: 'filament-1', slot: 1, preset: { isProjectEmbedded: false, isUser: false, id: 'p1', name: 'PLA', label: 'PLA', vendor: '' }, colour: { effective: '#112233', provenance: 'preset' as const, native: { representative: '#112233', multiColour: '#112233', type: '1' }, display: { mode: 'solid' as const, colors: ['#112233'] } } },
        { logicalId: 'filament-2', slot: 2, preset: { isProjectEmbedded: false, isUser: false, id: 'p2', name: 'PETG', label: 'PETG', vendor: '' }, colour: { effective: '#445566', provenance: 'user' as const, native: { representative: '#445566', multiColour: '#445566', type: '1' }, display: { mode: 'solid' as const, colors: ['#445566'] } } },
      ],
      mappings: { filament: [1, 2], volume: [0, 0], nozzle: [1, 1], filament2: [1, 1], physicalExtruder: [0, 0] },
      flushing: { matrix: [0, 1, 2, 0], vector: [0, 0], matrixDimension: 2, planeCount: 1, source: 'native' as const },
      capabilities: { minSlots: 1, maxSlots: 64, nozzleCount: 1, flexible: true, canAdd: true, canDelete: true, canMerge: true },
      assignments: { objects: [], parts: [], modifiers: [] },
      revisions: { session: 1, project: 1, result: 0, plates: {} },
      status: { state: 'ready' as const, error: null },
    };
    const rack = rememberedRackFromSnapshot(snapshot);
    expect(rack).toEqual({ version: 1, slots: [
      { preset: 'PLA', colour: '#112233', native: { representative: '#112233', multiColour: '#112233', type: '1' } },
      { preset: 'PETG', colour: '#445566', native: { representative: '#445566', multiColour: '#445566', type: '1' } },
    ] });
    const repository = { load: vi.fn(async () => prefs), save: vi.fn(async () => {}) };
    await publishRememberedFilamentRack(repository, 'Printer A', snapshot);
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ rememberedFilamentRacks: { 'Printer A': rack } }));
    expect(rememberedFilamentRack({ ...prefs, rememberedFilamentRacks: { 'Printer A': rack } }, 'Printer A')).toEqual(rack);
    expect(rememberedFilamentRack({ ...prefs, rememberedFilamentRacks: { 'Printer A': rack } }, 'Printer B')).toBeNull();
  });

  it('keeps malformed imported raw fields while persisting a safe effective colour', () => {
    const snapshot = { ok: true, slots: [{ preset: { name: 'PLA' }, colour: {
      effective: 'malformed', native: { representative: 'raw-unknown', multiColour: 'unparsed', type: 'future' },
      display: { mode: 'solid', colors: ['#26A69A'] },
    } }] } as never;
    expect(rememberedRackFromSnapshot(snapshot).slots[0]).toEqual({ preset: 'PLA', colour: '#26A69A',
      native: { representative: 'raw-unknown', multiColour: 'unparsed', type: 'future' } });
  });

  it('treats remembered-rack persistence failure as non-fatal', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const repository = { load: vi.fn(async () => prefs), save: vi.fn(async () => { throw new Error('storage unavailable'); }) };
    const snapshot = ({
      ok: true, version: 1, slots: [{ logicalId: 'filament-1', slot: 1, preset: { isProjectEmbedded: false, isUser: false, id: 'p', name: 'PLA', label: 'PLA', vendor: '' }, colour: { effective: '#112233', provenance: 'preset', native: { representative: '#112233', multiColour: '#112233', type: '1' }, display: { mode: 'solid' as const, colors: ['#112233'] } } }],
      mappings: { filament: [1], volume: [0], nozzle: [1], filament2: [1], physicalExtruder: [0] },
      flushing: { matrix: [0], vector: [0], matrixDimension: 1, planeCount: 1, source: 'native' },
      capabilities: { minSlots: 1, maxSlots: 64, nozzleCount: 1, flexible: true, canAdd: true, canDelete: true, canMerge: true },
      assignments: { objects: [], parts: [], modifiers: [] }, revisions: { session: 1, project: 1, result: 0, plates: {} }, status: { state: 'ready', error: null },
    }) as never;
    await expect(publishRememberedFilamentRack(repository, 'Printer A', snapshot)).resolves.toBeUndefined();
  });

  it('serializes concurrent rack writes so the newest slot projection wins', async () => {
    const makeSnapshot = (name: string) => ({
      ok: true as const, version: 1 as const,
      slots: [{ logicalId: 'filament-1', slot: 1, preset: { isProjectEmbedded: false, isUser: false, id: 'p', name, label: name, vendor: '' }, colour: { effective: '#112233', provenance: 'preset' as const, native: { representative: '#112233', multiColour: '#112233', type: '1' }, display: { mode: 'solid' as const, colors: ['#112233'] } } }],
      mappings: { filament: [1], volume: [0], nozzle: [1], filament2: [1], physicalExtruder: [0] },
      flushing: { matrix: [0], vector: [0], matrixDimension: 1, planeCount: 1, source: 'native' as const },
      capabilities: { minSlots: 1, maxSlots: 64, nozzleCount: 1, flexible: true, canAdd: true, canDelete: true, canMerge: true },
      assignments: { objects: [], parts: [], modifiers: [] },
      revisions: { session: 1, project: 1, result: 0, plates: {} }, status: { state: 'ready' as const, error: null },
    });
    const saved: UserPreferences[] = [];
    const repository: UserPreferencesRepository = {
      load: vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 1)); return prefs; }),
      save: vi.fn(async (value) => { saved.push(value); }),
    };
    await Promise.all([
      publishRememberedFilamentRack(repository, 'Printer A', makeSnapshot('First')),
      publishRememberedFilamentRack(repository, 'Printer A', makeSnapshot('Second')),
    ]);
    expect(saved).toHaveLength(2);
    expect(saved.at(-1)?.rememberedFilamentRacks?.['Printer A'].slots[0].preset).toBe('Second');
  });

  it('waits for the newest queued rack write before a printer transition reads it', async () => {
    const current = {
      ok: true as const, version: 1 as const,
      slots: [{ logicalId: 'filament-1', slot: 1, preset: { isProjectEmbedded: false, isUser: false, id: 'old', name: 'Old', label: 'Old', vendor: '' }, colour: { effective: '#112233', provenance: 'preset' as const, native: { representative: '#112233', multiColour: '#112233', type: '1' }, display: { mode: 'solid' as const, colors: ['#112233'] } } }],
      mappings: { filament: [1], volume: [0], nozzle: [1], filament2: [1], physicalExtruder: [0] },
      flushing: { matrix: [0], vector: [], matrixDimension: 1, planeCount: 1, source: 'native' as const },
      capabilities: { minSlots: 1, maxSlots: 64, nozzleCount: 1, flexible: true, canAdd: true, canDelete: false, canMerge: false },
      assignments: { objects: [], parts: [], modifiers: [] }, revisions: { session: 4, project: 4, result: 0, plates: {} },
      status: { state: 'ready' as const, error: null },
    };
    let stored: UserPreferences = { version: 1, rememberedBedTypes: {}, selectedProfiles: {}, ui: { switchToDeviceAfterSend: true } };
    let release!: () => void;
    const saveGate = new Promise<void>((resolve) => { release = resolve; });
    const repository: UserPreferencesRepository = {
      load: vi.fn(async () => stored),
      save: vi.fn(async (value) => { await saveGate; stored = value; }),
    };
    const newest = { ...current, slots: [{ ...current.slots[0], preset: { isProjectEmbedded: false, isUser: false, id: 'new', name: 'Newest', label: 'Newest', vendor: '' } }] };
    const publish = publishRememberedFilamentRack(repository, 'Printer A', newest);
    await Promise.resolve();
    const apply = vi.fn(async () => ({ ...newest, revisions: { ...newest.revisions, session: 5, project: 5 } }));
    const transition = applyRememberedFilamentRackFromRepository(repository, {
      getFilamentSessionSnapshot: vi.fn(async () => current),
      applyRememberedFilamentRack: apply,
    }, 'Printer A');
    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();
    release();
    await publish;
    await transition;
    expect(apply).toHaveBeenCalledWith({ version: 1, revision: 4,
      slots: [{ preset: 'Newest', colour: '#112233', native: { representative: '#112233', multiColour: '#112233', type: '1' } }] });
  });

  it('keeps the native printer defaults when its remembered rack cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const getFilamentSessionSnapshot = vi.fn();
    const applyRememberedFilamentRack = vi.fn();
    await expect(applyRememberedFilamentRackFromRepository({
      load: vi.fn(async () => { throw new Error('storage unavailable'); }),
      save: vi.fn(),
    }, { getFilamentSessionSnapshot, applyRememberedFilamentRack }, 'Printer A')).resolves.toBeNull();
    expect(getFilamentSessionSnapshot).not.toHaveBeenCalled();
    expect(applyRememberedFilamentRack).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('remembered filament rack load failed; keeping native defaults', expect.any(Error));
    warn.mockRestore();
  });

  it('restores profiles, applies that printer rack, then establishes one clean boot baseline', async () => {
    const initial = snapshot('default-printer', 'default-print', 'default-filament');
    const resolved = snapshot('P', 'Q', 'PLA');
    const current = {
      ok: true as const, version: 1 as const,
      slots: [{ logicalId: 'filament-1', slot: 1, preset: { isProjectEmbedded: false, isUser: false, id: 'PLA', name: 'PLA', label: 'PLA', vendor: '' }, colour: { effective: '#111111', provenance: 'preset' as const, native: { representative: '#111111', multiColour: '#111111', type: '1' }, display: { mode: 'solid' as const, colors: ['#111111'] } } }],
      mappings: { filament: [1], volume: [0], nozzle: [1], filament2: [1], physicalExtruder: [0] },
      flushing: { matrix: [0], vector: [], matrixDimension: 1, planeCount: 1, source: 'native' as const },
      capabilities: { minSlots: 1, maxSlots: 64, nozzleCount: 1, flexible: true, canAdd: true, canDelete: false, canMerge: false },
      assignments: { objects: [], parts: [], modifiers: [] }, revisions: { session: 2, project: 2, result: 0, plates: {} },
      status: { state: 'ready' as const, error: null },
    };
    const restoredRack = { ...current, slots: [{ ...current.slots[0], colour: { effective: '#abcdef', provenance: 'user' as const, native: { representative: '#abcdef', multiColour: '#abcdef', type: '1' }, display: { mode: 'solid' as const, colors: ['#abcdef'] } } }], revisions: { ...current.revisions, session: 3, project: 3 } };
    const finalRack = { ...restoredRack, revisions: { ...restoredRack.revisions, session: 4, project: 4 } };
    const calls: string[] = [];
    const getRack = vi.fn(async () => { calls.push('get-rack'); return getRack.mock.calls.length === 1 ? current : finalRack; });
    const result = await restoreBootstrapSession({
      setAutoFlushPolicy: vi.fn(async () => ({ ok: true })),
      configureProjectFlowMemory: vi.fn(async () => { calls.push('seed-flow'); return { ok: true as const }; }),
      mutateNativeScopedConfig: vi.fn(async () => { calls.push('seed-bed'); return { ok: true, nativeScopedConfig: { kind: 'full' } } as never; }),
      getProfileSnapshot: vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(resolved),
      selectProfile: vi.fn(async (kind) => { calls.push(`select-${kind}`); return resolved; }),
      getFilamentSessionSnapshot: getRack,
      applyRememberedFilamentRack: vi.fn(async () => { calls.push('apply-rack'); return restoredRack; }),
      resetHistory: vi.fn(async () => { calls.push('reset-history'); return { dirty: false, canUndo: false, undoEntries: [] } as never; }),
    }, { ...prefs, rememberedBedTypes: { P: 'Textured PEI Plate' }, rememberedFilamentRacks: { P: { version: 1, slots: [{ preset: 'PLA', colour: '#abcdef', native: { representative: '#abcdef', multiColour: '#abcdef', type: '1' } }] } } }, {
      selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] }, activePlateId: null, gizmo: null,
      nativeScopedConfig: { project: {}, objects: {}, parts: {}, plates: {} },
    });
    expect(calls).toEqual(['select-printer', 'select-print', 'get-rack', 'apply-rack', 'seed-bed', 'seed-flow', 'reset-history', 'get-rack']);
    expect(result.filament).toBe(finalRack);
    expect(result.history).toMatchObject({ dirty: false, canUndo: false, undoEntries: [] });
  });
});

describe('bed preference memory', () => {
  it('keeps printer memories independent and preserves unrelated preferences across serialized writes', async () => {
    let stored: UserPreferences = { ...prefs, arrangement: { ignored: true } as never };
    const repository = { load: vi.fn(async () => stored), save: vi.fn(async (next: UserPreferences) => { stored = next; }) };
    await Promise.all([publishRememberedBedType(repository, 'A', 'High Temp Plate'), publishRememberedBedType(repository, 'B', 'Textured PEI Plate')]);
    expect(stored.rememberedBedTypes).toEqual({ A: 'High Temp Plate', B: 'Textured PEI Plate' });
    expect(stored.selectedProfiles).toEqual(prefs.selectedProfiles);
    expect(stored.arrangement).toEqual({ ignored: true });
    const pending = publishRememberedBedType(repository, 'A', 'Engineering Plate');
    expect(await loadRememberedBedTypeFromRepository(repository, 'A')).toBe('Engineering Plate');
    await pending;
  });
  it('treats failed writes and reads as nonfatal', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repository = { load: vi.fn(async () => { throw new Error('offline'); }), save: vi.fn() };
    await expect(publishRememberedBedType(repository, 'A', 'High Temp Plate')).resolves.toBeUndefined();
    await expect(loadRememberedBedTypeFromRepository(repository, 'A')).resolves.toBeNull();
    error.mockRestore(); warn.mockRestore();
  });
  it('seeds only allowed bed memory before a clean baseline and ignores unsupported or stale choices', async () => {
    const selected = snapshot('P', 'Q', 'PLA');
    const runtime = { getProfileSnapshot: vi.fn(async () => selected), mutateNativeScopedConfig: vi.fn(async () => ({ ok: true, nativeScopedConfig: { kind: 'delta' } } as never)) };
    await seedRememberedBedType(runtime, 'Textured PEI Plate');
    expect(runtime.mutateNativeScopedConfig).toHaveBeenCalledWith({ version: 1, operation: 'set', targets: [{ scope: 'project' }], key: 'curr_bed_type', value: 'Textured PEI Plate' });
    await seedRememberedBedType(runtime, 'obsolete');
    selected.bedType = { ...selected.bedType, supportsSelection: false };
    await seedRememberedBedType(runtime, 'Textured PEI Plate');
    expect(runtime.mutateNativeScopedConfig).toHaveBeenCalledOnce();
  });
});


describe('base Printer project-flow preferences', () => {
  const context = { selection: { mode: 'object' as const, objectIds: [], partIds: [], instanceIds: [] },
    activePlateId: null, gizmo: null, nativeScopedConfig: {} };
  async function fixture() {
    const runtime = createClient(async () => createMockModule());
    await runtime.init(MOCK_PROFILE_ACTIVATION);
    const profile = await runtime.getProfileSnapshot();
    if (!profile.ok) throw new Error(profile.error);
    let stored: UserPreferences = structuredClone(prefs);
    const repository = { load: vi.fn(async () => structuredClone(stored)),
      save: vi.fn(async (next: UserPreferences) => { stored = structuredClone(next); }) };
    return { runtime, profile, repository, stored: () => stored };
  }
  it('seeds only a fresh project, preserves live same-base flow, and stores Hybrid as Standard after publication', async () => {
    const f = await fixture(); const base = f.profile.printerPicker.basePrinter;
    await f.repository.save({ ...prefs, rememberedProjectFlows: { [base]: [1] } });
    const history = await f.runtime.getHistoryStatus();
    await configureProjectFlowPreferences(f.repository, f.runtime, true);
    expect(await f.runtime.getProfileSnapshot()).toMatchObject({ printerPicker: { flows: [{ actual: 1 }] } });
    expect(await f.runtime.getHistoryStatus()).toEqual(history);
    const publish = vi.fn(async () => { expect(f.stored().rememberedProjectFlows![base]).toEqual([1]); });
    const changed = await commitProjectFlow(f.runtime, f.repository,
      { index: 0, flow: 2, expectedRevision: history.revision, context }, publish);
    expect(changed).toMatchObject({ ok: true, profileSnapshot: { printerPicker: { flows: [{ actual: 2 }] } } });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(f.stored().rememberedProjectFlows![base]).toEqual([0]);
    await configureProjectFlowPreferences(f.repository, f.runtime, false);
    const same = await f.runtime.selectPrinterWithRememberedRack(f.profile.printer.name, null, null, context);
    expect(same).toMatchObject({ ok: true, profileSnapshot: { printerPicker: { flows: [{ actual: 2 }] } } });
    const saves = f.repository.save.mock.calls.length;
    await f.runtime.undoHistory(); await f.runtime.redoHistory();
    expect(f.repository.save).toHaveBeenCalledTimes(saves);
    expect(f.stored().rememberedProjectFlows![base]).toEqual([0]);
  });
  it('remembers the known native prefix when later physical heads have no actual flow', async () => {
    const f = await fixture();
    const runtime = { setProjectFlow: async (...args: Parameters<typeof f.runtime.setProjectFlow>) => {
      const result = await f.runtime.setProjectFlow(...args);
      if (result.ok) result.profileSnapshot.printerPicker.flows.push({ actual: null, choices: [] });
      return result;
    } };
    const result = await commitProjectFlow(runtime, f.repository,
      { index: 0, flow: 1, expectedRevision: (await f.runtime.getHistoryStatus()).revision, context }, () => {});
    expect(result.ok).toBe(true);
    expect(f.stored().rememberedProjectFlows![f.profile.printerPicker.basePrinter]).toEqual([1]);
  });
  it('keeps accepted native state on persistence failure and never persists rejection or failed publication', async () => {
    const f = await fixture(); const publish = vi.fn(); const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    f.repository.save.mockRejectedValueOnce(new Error('disk full'));
    const accepted = await commitProjectFlow(f.runtime, f.repository,
      { index: 0, flow: 1, expectedRevision: (await f.runtime.getHistoryStatus()).revision, context }, publish);
    expect(accepted.ok).toBe(true); expect(publish).toHaveBeenCalledTimes(1);
    expect(await f.runtime.getProfileSnapshot()).toMatchObject({ printerPicker: { flows: [{ actual: 1 }] } });
    expect(f.stored().rememberedProjectFlows).toBeUndefined();
    const writes = f.repository.save.mock.calls.length;
    const rejected = await commitProjectFlow(f.runtime, f.repository, { index: 0, flow: 0, expectedRevision: 999, context }, publish);
    expect(rejected.ok).toBe(false); expect(f.repository.save).toHaveBeenCalledTimes(writes);
    await expect(commitProjectFlow(f.runtime, f.repository,
      { index: 0, flow: 2, expectedRevision: (await f.runtime.getHistoryStatus()).revision, context }, () => { throw new Error('publication failed'); }))
      .rejects.toThrow('publication failed');
    expect(f.repository.save).toHaveBeenCalledTimes(writes);
    expect(await f.runtime.getProfileSnapshot()).toMatchObject({ printerPicker: { flows: [{ actual: 2 }] } });
    log.mockRestore();
  });
  it('serializes global read/modify/write with unrelated preferences and loads after queued writes', async () => {
    const a = await fixture(); const b = await fixture();
    await b.runtime.selectProfile('printer', 'Bambu Lab P1S 0.4 nozzle');
    await Promise.all([
      commitProjectFlow(a.runtime, a.repository, { index: 0, flow: 1, expectedRevision: (await a.runtime.getHistoryStatus()).revision, context }, () => {}),
      commitProjectFlow(b.runtime, a.repository, { index: 0, flow: 1, expectedRevision: (await b.runtime.getHistoryStatus()).revision, context }, () => {}),
      publishRememberedBedType(a.repository, 'Other', 'High Temp Plate'),
    ]);
    expect(Object.keys(a.stored().rememberedProjectFlows!)).toHaveLength(2);
    expect(a.stored().rememberedBedTypes.Other).toBe('High Temp Plate');
    expect(a.stored().selectedProfiles).toEqual(prefs.selectedProfiles);
    await configureProjectFlowPreferences(a.repository, a.runtime, true);
    expect(await a.runtime.getProfileSnapshot()).toMatchObject({ printerPicker: { flows: [{ actual: 1 }] } });
  });
});
