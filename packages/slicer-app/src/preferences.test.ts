import { describe, expect, it, vi } from 'vitest';
import { restoreSelections } from './preferences';
import type { UserPreferences } from '@orca/platform-contract';

const prefs: UserPreferences = { version: 1, selectedProfiles: { printer: 'P', print: 'Q', filament: 'F' }, ui: {} };

// The client selection API now returns an atomic compatibility snapshot. The
// restoration tests still exercise only name resolution, so candidate arrays
// are intentionally empty fixtures here.
function snapshot(printer: string, print: string, filament: string) {
  return {
    ok: true as const,
    printers: [], prints: [], filaments: [],
    printer: { name: printer, idx: 0 },
    print: { name: print, idx: 0 },
    filament: { name: filament, idx: 0 },
  };
}

describe('selection restoration', () => {
  it('restores in printer, print, filament order and accepts bridge results', async () => {
    const calls: string[] = [];
    const result = await restoreSelections({ getPresets: async () => ({ presets: [] }), selectPreset: async (kind) => {
      calls.push(kind); return snapshot('P2', 'Q2', 'F2');
    } }, prefs);
    expect(calls).toEqual(['printer', 'print', 'filament']);
    expect(result.selectedProfiles).toEqual({ printer: 'P2', print: 'Q2', filament: 'F2' });
  });
  it('keeps defaults when a saved name is unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await restoreSelections({
      getPresets: async (kind) => ({ presets: [{ name: `${kind}-first`, is_visible: true } as never] }),
      selectPreset: async (_kind, name) => name.endsWith('first')
        ? snapshot('D', 'D', 'D')
        : { error: 'preset not found' },
    }, prefs);
    expect(result.selectedProfiles).toEqual({ printer: 'D', print: 'D', filament: 'D' });
  });
});
