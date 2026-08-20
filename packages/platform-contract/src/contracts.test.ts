import { describe, expect, it } from 'vitest';
import { normalizeUserPreferences, type GcodeExporter, type ModelImporter, type ProfileSource, type SlicerRuntime, type UserPreferencesRepository } from './contracts';

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

describe('host contracts', () => {
  it('allows dependency-free fake host services', async () => {
    const importer: ModelImporter = {
      async pick() { return { displayName: 'cube.stl', bytes: new Uint8Array([1, 2]) }; },
    };
    const exporter: GcodeExporter = { async save() {} };
    let prefs = normalizeUserPreferences(null);
    const preferences: UserPreferencesRepository = {
      async load() { return prefs; },
      async save(value) { prefs = value; },
    };
    const profileBytes = new Uint8Array([123]);
    const profiles: ProfileSource = { async fetch(path) { expect(path).toBe('manifest.json'); return profileBytes; } };
    const runtime = {} as SlicerRuntime;
    await expect(importer.pick()).resolves.toMatchObject({ displayName: 'cube.stl' });
    await exporter.save('out.gcode', new Uint8Array());
    await preferences.save({ ...prefs, ui: { sidebarWidth: 280 } });
    await expect(preferences.load()).resolves.toMatchObject({ ui: { sidebarWidth: 280 } });
    await expect(profiles.fetch('manifest.json')).resolves.toEqual(profileBytes);
    expect(runtime).toBeDefined();
  });
});
