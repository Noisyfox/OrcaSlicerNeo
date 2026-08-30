import { describe, expect, it, vi } from 'vitest';
import { persistRestoredSelections, restoreSelections } from './preferences';
import type { UserPreferences } from '@orca/platform-contract';
import type { PresetSnapshot } from '@slicer/client';

const prefs: UserPreferences = {
  version: 1,
  selectedProfiles: { printer: 'P', print: 'Q', filament: 'F' },
  ui: {},
};

function snapshot(printer: string, print: string, filament: string): PresetSnapshot {
  return {
    ok: true,
    printers: [{ name: printer, is_visible: true, is_default: false, vendor_id: '', model: '', variant: '', selected: true }],
    prints: [{ name: print, is_visible: true, is_default: false, vendor_id: '', model: '', variant: '', selected: true }],
    filaments: [{ name: filament, is_visible: true, is_default: false, vendor_id: '', model: '', variant: '', selected: true }],
    printer: { name: printer, idx: 0 },
    print: { name: print, idx: 0 },
    filament: { name: filament, idx: 0 },
  };
}

describe('selection restoration', () => {
  it('restores printer, print, then filament and returns the final atomic snapshot', async () => {
    const initial = snapshot('default-printer', 'default-print', 'default-filament');
    const final = snapshot('P2', 'Q2', 'F2');
    const calls: Array<[string, string]> = [];
    const result = await restoreSelections({
      getPresetSnapshot: vi.fn(async () => initial),
      selectPreset: vi.fn(async (kind, name) => {
        calls.push([kind, name]);
        return final;
      }),
    }, prefs);

    expect(calls).toEqual([['printer', 'P'], ['print', 'Q'], ['filament', 'F']]);
    expect(result.snapshot).toBe(final);
    expect(result.preferences.selectedProfiles).toEqual({ printer: 'P2', print: 'Q2', filament: 'F2' });
  });

  it('uses the current snapshot candidate after a rejected saved name, then keeps later candidates current', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const initial = snapshot('engine-printer', 'engine-print', 'engine-filament');
    const afterPrinter = snapshot('fallback-printer', 'printer-print', 'printer-filament');
    const afterPrint = snapshot('fallback-printer', 'fallback-print', 'print-filament');
    const final = snapshot('fallback-printer', 'fallback-print', 'fallback-filament');
    const calls: Array<[string, string]> = [];
    const result = await restoreSelections({
      getPresetSnapshot: async () => initial,
      selectPreset: async (kind, name) => {
        calls.push([kind, name]);
        if (kind === 'printer' && name === 'P') return { error: 'not available' };
        if (kind === 'printer') return afterPrinter;
        if (kind === 'print' && name === 'Q') return { error: 'not available' };
        if (kind === 'print') return afterPrint;
        if (kind === 'filament' && name === 'F') return { error: 'not available' };
        return final;
      },
    }, prefs);

    expect(calls).toEqual([
      ['printer', 'P'], ['printer', 'engine-printer'],
      ['print', 'Q'], ['print', 'printer-print'],
      ['filament', 'F'], ['filament', 'print-filament'],
    ]);
    expect(result.snapshot).toBe(final);
    expect(result.preferences.selectedProfiles).toEqual({
      printer: 'fallback-printer', print: 'fallback-print', filament: 'fallback-filament',
    });
  });

  it('uses engine-selected candidates when preferences are absent', async () => {
    const initial = snapshot('engine-printer', 'engine-print', 'engine-filament');
    const final = snapshot('resolved-printer', 'resolved-print', 'resolved-filament');
    const calls: Array<[string, string]> = [];
    const result = await restoreSelections({
      getPresetSnapshot: async () => initial,
      selectPreset: async (kind, name) => {
        calls.push([kind, name]);
        return final;
      },
    }, { version: 1, selectedProfiles: {}, ui: {} });

    expect(calls).toEqual([
      ['printer', 'engine-printer'],
      ['print', 'resolved-print'],
      ['filament', 'resolved-filament'],
    ]);
    expect(result.preferences.selectedProfiles).toEqual({
      printer: 'resolved-printer', print: 'resolved-print', filament: 'resolved-filament',
    });
  });

  it('persists the resolved triple without failing the already-valid boot state on storage errors', async () => {
    const preferences = {
      version: 1 as const,
      selectedProfiles: { printer: 'resolved-printer', print: 'resolved-print', filament: 'resolved-filament' },
      ui: {},
    };
    const repository = { load: vi.fn(), save: vi.fn(async () => {}) };
    await persistRestoredSelections(repository, preferences);
    expect(repository.save).toHaveBeenCalledWith(preferences);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    repository.save.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(persistRestoredSelections(repository, preferences)).resolves.toBeUndefined();
  });
});
