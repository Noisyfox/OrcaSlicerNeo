import { describe, expect, it, vi } from 'vitest';
import { restoreSelections } from './preferences';
import type { UserPreferences } from '@orca/platform-contract';

const prefs: UserPreferences = { version: 1, selectedProfiles: { printer: 'P', print: 'Q', filament: 'F' }, ui: {} };
describe('selection restoration', () => {
  it('restores in printer, print, filament order and accepts bridge results', async () => {
    const calls: string[] = [];
    const result = await restoreSelections({ selectPreset: async (kind) => {
      calls.push(kind); return { ok: true, printer: { name: 'P2', idx: 0 }, print: { name: 'Q2', idx: 0 }, filament: { name: 'F2', idx: 0 } };
    } }, prefs);
    expect(calls).toEqual(['printer', 'print', 'filament']);
    expect(result.selectedProfiles).toEqual({ printer: 'P2', print: 'Q2', filament: 'F2' });
  });
  it('keeps defaults when a saved name is unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await restoreSelections({ selectPreset: async () => ({ ok: false, printer: { name: 'D', idx: 0 }, print: { name: 'D', idx: 0 }, filament: { name: 'D', idx: 0 } }) }, prefs);
    expect(result).toBe(prefs);
  });
});
