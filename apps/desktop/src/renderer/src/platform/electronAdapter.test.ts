import { describe, expect, it, vi } from 'vitest';
import { createElectronAdapter } from './electronAdapter';

describe('Electron preferences adapter', () => {
  it('normalizes load and writes the shared preference shape', async () => {
    const load = vi.fn(async () => ({ found: true, json: { version: 1, selectedProfiles: { printer: 'P' }, ui: { sidebarWidth: 320 } } }));
    const save = vi.fn(async () => {});
    vi.stubGlobal('window', { orca: { appConfig: { load, save }, platform: 'win32' } });
    const adapter = createElectronAdapter({} as never);
    expect(await adapter.preferences.load()).toEqual({ version: 1, selectedProfiles: { printer: 'P' }, ui: { sidebarWidth: 320 } });
    await adapter.preferences.save({ version: 1, selectedProfiles: { filament: 'F' }, ui: {} });
    expect(save).toHaveBeenCalledWith({ version: 1, selectedProfiles: { filament: 'F' }, ui: {} });
  });
});
