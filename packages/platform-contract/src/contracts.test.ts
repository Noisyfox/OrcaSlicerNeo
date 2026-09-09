import { describe, expect, it } from 'vitest';
import { normalizeGcodeTextWindowGeometry, normalizeUserPreferences, type GcodeExporter, type ModelImporter, type ProfileSource, type SlicerRuntime, type UserPreferencesRepository, type PrinterConfigurationRepository, type WebViewHost } from './contracts';
import { normalizePrinterConfigurationDocument } from '@orca/printer-control';

describe('user preferences', () => {
  it('discards malformed and unsupported versions', () => {
    expect(normalizeUserPreferences({ version: 2, selectedProfiles: { printer: 'bad' } }).selectedProfiles).toEqual({});
    expect(normalizeUserPreferences('{bad}').ui).toEqual({ switchToDeviceAfterSend: true });
  });
  it('keeps only the typed profile names and UI preferences', () => {
    expect(normalizeUserPreferences({ version: 1, selectedProfiles: { printer: 'P', print: 'Standard', ignored: true }, ui: { sidebarWidth: 280, deviceSidebarWidth: 320, x: true } })).toEqual({
      version: 1, projectLoadBehaviour: 'ask_when_relevant', selectedProfiles: { printer: 'P', print: 'Standard' }, ui: { sidebarWidth: 280, deviceSidebarWidth: 320, switchToDeviceAfterSend: true },
    });
  });

  it('normalizes the project-load behaviour and defaults missing or invalid values', () => {
    expect(normalizeUserPreferences(null).projectLoadBehaviour).toBe('ask_when_relevant');
    expect(normalizeUserPreferences({ version: 1, projectLoadBehaviour: 'load_all' }).projectLoadBehaviour).toBe('load_all');
    expect(normalizeUserPreferences({ version: 1, projectLoadBehaviour: 'not-a-policy' }).projectLoadBehaviour).toBe('ask_when_relevant');
  });

  it('keeps workspace and device sidebar widths independent', () => {
    const normalized = normalizeUserPreferences({ version: 1, ui: { sidebarWidth: 280, deviceSidebarWidth: 360 } });
    expect(normalized.ui).toEqual({ sidebarWidth: 280, deviceSidebarWidth: 360, switchToDeviceAfterSend: true });
  });

  it('preserves the send navigation preference and migrates old preferences to enabled', () => {
    expect(normalizeUserPreferences({ version: 1, ui: { switchToDeviceAfterSend: false } }).ui.switchToDeviceAfterSend).toBe(false);
    expect(normalizeUserPreferences({ version: 1, ui: {} }).ui.switchToDeviceAfterSend).toBe(true);
  });

  it('keeps only valid printer-namespaced remembered racks', () => {
    const normalized = normalizeUserPreferences({ version: 1, rememberedFilamentRacks: {
      'Printer A': { version: 1, slots: [{ preset: 'PLA', colour: '#112233' }] },
      'Printer B': { version: 1, slots: [{ preset: '', colour: '#112233' }] },
      'Printer C': { version: 2, slots: [{ preset: 'PLA', colour: '#112233' }] },
    } });
    expect(normalized.rememberedFilamentRacks).toEqual({
      'Printer A': { version: 1, slots: [{ preset: 'PLA', colour: '#112233' }] },
    });
  });

  it('keeps a complete finite G-code window geometry and rejects malformed values', () => {
    const geometry = { left: 12, top: 24, width: 560, height: 424 };
    expect(normalizeGcodeTextWindowGeometry(geometry)).toEqual(geometry);
    expect(normalizeGcodeTextWindowGeometry({ ...geometry, width: Number.NaN })).toBeUndefined();
    expect(normalizeGcodeTextWindowGeometry({ ...geometry, height: '424' })).toBeUndefined();
    expect(normalizeUserPreferences({ version: 1, ui: { gcodeTextWindow: geometry } }).ui.gcodeTextWindow).toEqual(geometry);
    expect(normalizeUserPreferences({ version: 1, ui: { gcodeTextWindow: { ...geometry, left: Infinity } } }).ui.gcodeTextWindow).toBeUndefined();
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
    const printers: PrinterConfigurationRepository = {
      async load() { return normalizePrinterConfigurationDocument({ version: 1, printers: [] }); },
      async save(document) { expect(document.version).toBe(1); },
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
    await printers.save(await printers.load());
  });

  it('defines a host-neutral WebView surface with explicit capabilities', () => {
    const capabilities = {
      canInjectBuiltInScripts: false,
      canExposeHostApi: false,
      canExecuteJavaScript: false,
    } as const;
    const webview: WebViewHost = {
      capabilities,
      mount() {
        return {
          capabilities,
          state: { status: 'idle', url: null, error: null },
          load() {},
          registerBuiltInScript() { return { status: 'unsupported', reason: 'capability-unavailable' }; },
          exposeHostApi() { return { status: 'unsupported', reason: 'capability-unavailable' }; },
          async executeJavaScript() { return { status: 'unsupported', reason: 'capability-unavailable' }; },
          dispose() {},
        };
      },
    };
    expect(webview.capabilities.canExecuteJavaScript).toBe(false);
    expect(webview.mount({} as HTMLElement).state.status).toBe('idle');
  });
});
