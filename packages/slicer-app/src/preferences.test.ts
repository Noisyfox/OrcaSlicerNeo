import { describe, expect, it, vi } from 'vitest';
import { applyRememberedFilamentRackFromRepository, rememberedFilamentRack, rememberedRackFromSnapshot, persistRestoredSelections, publishRememberedFilamentRack, restoreBootstrapSession, restoreSelections } from './preferences';
import type { UserPreferences, UserPreferencesRepository } from '@orca/platform-contract';
import type { ProfileSnapshot } from '@slicer/client';

const prefs: UserPreferences = {
  version: 1,
  selectedProfiles: { printer: 'P', print: 'Q' },
  ui: { switchToDeviceAfterSend: true },
};

function snapshot(printer: string, print: string, filament: string): ProfileSnapshot {
  return {
    ok: true,
    printers: [{ name: printer, is_visible: true, is_default: false, vendor_id: '', model: '', variant: '', selected: true }],
    prints: [{ name: print, is_visible: true, is_default: false, vendor_id: '', model: '', variant: '', selected: true }],
    filamentCatalog: [{ name: filament, is_visible: true, is_default: false, vendor_id: '', model: '', variant: '' }],
    printer: { name: printer, idx: 0 },
    print: { name: print, idx: 0 },
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
    }, { version: 1, selectedProfiles: {}, ui: { switchToDeviceAfterSend: true } });

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
      selectedProfiles: { printer: 'resolved-printer', print: 'resolved-print' },
      ui: { switchToDeviceAfterSend: true },
    };
    const repository = { load: vi.fn(), save: vi.fn(async () => {}) };
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
        { slot: 1, preset: { id: 'p1', name: 'PLA' }, colour: { effective: '#112233', provenance: 'preset' as const } },
        { slot: 2, preset: { id: 'p2', name: 'PETG' }, colour: { effective: '#445566', provenance: 'user' as const } },
      ],
      mappings: { filament: [1, 2], volume: [0, 0], nozzle: [1, 1], filament2: [1, 1], physicalExtruder: [0, 0] },
      flushing: { matrix: [0, 1, 2, 0], vector: [0, 0], matrixDimension: 2, planeCount: 1, source: 'native' as const },
      capabilities: { minSlots: 1, maxSlots: 64, nozzleCount: 1, flexible: true, canAdd: true, canDelete: true, canMerge: true },
      assignments: { objects: [], parts: [], modifiers: [] },
      revisions: { session: 1, project: 1, result: 0, plates: {} },
      status: { state: 'ready' as const, error: null },
    };
    const rack = rememberedRackFromSnapshot(snapshot);
    expect(rack).toEqual({ version: 1, slots: [{ preset: 'PLA', colour: '#112233' }, { preset: 'PETG', colour: '#445566' }] });
    const repository = { load: vi.fn(async () => prefs), save: vi.fn(async () => {}) };
    await publishRememberedFilamentRack(repository, 'Printer A', snapshot);
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ rememberedFilamentRacks: { 'Printer A': rack } }));
    expect(rememberedFilamentRack({ ...prefs, rememberedFilamentRacks: { 'Printer A': rack } }, 'Printer A')).toEqual(rack);
    expect(rememberedFilamentRack({ ...prefs, rememberedFilamentRacks: { 'Printer A': rack } }, 'Printer B')).toBeNull();
  });

  it('treats remembered-rack persistence failure as non-fatal', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const repository = { load: vi.fn(async () => prefs), save: vi.fn(async () => { throw new Error('storage unavailable'); }) };
    const snapshot = ({
      ok: true, version: 1, slots: [{ slot: 1, preset: { id: 'p', name: 'PLA' }, colour: { effective: '#112233', provenance: 'preset' } }],
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
      slots: [{ slot: 1, preset: { id: 'p', name }, colour: { effective: '#112233', provenance: 'preset' as const } }],
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
      slots: [{ slot: 1, preset: { id: 'old', name: 'Old' }, colour: { effective: '#112233', provenance: 'preset' as const } }],
      mappings: { filament: [1], volume: [0], nozzle: [1], filament2: [1], physicalExtruder: [0] },
      flushing: { matrix: [0], vector: [], matrixDimension: 1, planeCount: 1, source: 'native' as const },
      capabilities: { minSlots: 1, maxSlots: 64, nozzleCount: 1, flexible: true, canAdd: true, canDelete: false, canMerge: false },
      assignments: { objects: [], parts: [], modifiers: [] }, revisions: { session: 4, project: 4, result: 0, plates: {} },
      status: { state: 'ready' as const, error: null },
    };
    let stored: UserPreferences = { version: 1, selectedProfiles: {}, ui: { switchToDeviceAfterSend: true } };
    let release!: () => void;
    const saveGate = new Promise<void>((resolve) => { release = resolve; });
    const repository: UserPreferencesRepository = {
      load: vi.fn(async () => stored),
      save: vi.fn(async (value) => { await saveGate; stored = value; }),
    };
    const newest = { ...current, slots: [{ ...current.slots[0], preset: { id: 'new', name: 'Newest' } }] };
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
      slots: [{ preset: 'Newest', colour: '#112233' }] });
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
      slots: [{ slot: 1, preset: { id: 'PLA', name: 'PLA' }, colour: { effective: '#111111', provenance: 'preset' as const } }],
      mappings: { filament: [1], volume: [0], nozzle: [1], filament2: [1], physicalExtruder: [0] },
      flushing: { matrix: [0], vector: [], matrixDimension: 1, planeCount: 1, source: 'native' as const },
      capabilities: { minSlots: 1, maxSlots: 64, nozzleCount: 1, flexible: true, canAdd: true, canDelete: false, canMerge: false },
      assignments: { objects: [], parts: [], modifiers: [] }, revisions: { session: 2, project: 2, result: 0, plates: {} },
      status: { state: 'ready' as const, error: null },
    };
    const restoredRack = { ...current, slots: [{ ...current.slots[0], colour: { effective: '#abcdef', provenance: 'user' as const } }], revisions: { ...current.revisions, session: 3, project: 3 } };
    const finalRack = { ...restoredRack, revisions: { ...restoredRack.revisions, session: 4, project: 4 } };
    const calls: string[] = [];
    const getRack = vi.fn(async () => { calls.push('get-rack'); return getRack.mock.calls.length === 1 ? current : finalRack; });
    const result = await restoreBootstrapSession({
      getProfileSnapshot: vi.fn(async () => initial),
      selectProfile: vi.fn(async (kind) => { calls.push(`select-${kind}`); return resolved; }),
      getFilamentSessionSnapshot: getRack,
      applyRememberedFilamentRack: vi.fn(async () => { calls.push('apply-rack'); return restoredRack; }),
      resetHistory: vi.fn(async () => { calls.push('reset-history'); return { dirty: false, canUndo: false, undoEntries: [] } as never; }),
    }, { ...prefs, rememberedFilamentRacks: { P: { version: 1, slots: [{ preset: 'PLA', colour: '#abcdef' }] } } }, {
      selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] }, activePlateId: null, gizmo: null,
      nativeScopedConfig: { project: {}, objects: {}, parts: {}, plates: {} },
    });
    expect(calls).toEqual(['select-printer', 'select-print', 'get-rack', 'apply-rack', 'reset-history', 'get-rack']);
    expect(result.filament).toBe(finalRack);
    expect(result.history).toMatchObject({ dirty: false, canUndo: false, undoEntries: [] });
  });
});
