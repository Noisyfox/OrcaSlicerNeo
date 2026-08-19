import { describe, expect, it } from 'vitest';
import { normalizeUserPreferences } from './contracts';

describe('user preferences', () => {
  it('discards malformed and unsupported versions', () => {
    expect(normalizeUserPreferences({ version: 2, selectedProfiles: { printer: 'bad' } }).selectedProfiles).toEqual({});
    expect(normalizeUserPreferences('{bad}').ui).toEqual({});
  });
  it('keeps only the typed profile names and UI width', () => {
    expect(normalizeUserPreferences({ version: 1, selectedProfiles: { printer: 'P', print: 4, filament: 'F' }, ui: { sidebarWidth: 280, x: true } })).toEqual({
      version: 1, selectedProfiles: { printer: 'P', filament: 'F' }, ui: { sidebarWidth: 280 },
    });
  });
});
