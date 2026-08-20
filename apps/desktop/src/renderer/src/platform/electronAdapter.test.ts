import { describe, expect, it, vi } from 'vitest';
import { createElectronAdapter } from './electronAdapter';

function setup(overrides: Record<string, unknown> = {}) {
    const load = vi.fn(async () => ({ found: true, json: { version: 1, selectedProfiles: { printer: 'P' }, ui: { sidebarWidth: 320 } } }));
    const save = vi.fn(async () => {});
    const host = { appConfig: { load, save }, platform: 'win32', ...overrides };
    vi.stubGlobal('window', { orca: host });
    return { adapter: createElectronAdapter({} as never), load, save };
}

describe('Electron adapter', () => {
  it('normalizes load and writes the shared preference shape', async () => {
    const { adapter, save } = setup();
    expect(await adapter.preferences.load()).toEqual({ version: 1, selectedProfiles: { printer: 'P' }, ui: { sidebarWidth: 320 } });
    await adapter.preferences.save({ version: 1, selectedProfiles: { filament: 'F' }, ui: {} });
    expect(save).toHaveBeenCalledWith({ version: 1, selectedProfiles: { filament: 'F' }, ui: {} });
  });

  it('maps native import success to display name and bytes', async () => {
    const { adapter } = setup({ openFileDialog: vi.fn(async () => ({ canceled: false, path: 'C:\\models\\cube.stl' })), readFile: vi.fn(async () => Uint8Array.from([1, 2]).buffer) });
    await expect(adapter.models.pick()).resolves.toEqual({ displayName: 'cube.stl', bytes: Uint8Array.from([1, 2]) });
  });

  it('returns cancellation without reading a file', async () => {
    const readFile = vi.fn();
    const { adapter } = setup({ openFileDialog: vi.fn(async () => ({ canceled: true, path: null })), readFile });
    await expect(adapter.models.pick()).resolves.toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('hands export bytes to native save dialog and write operation', async () => {
    const saveFileDialog = vi.fn(async () => ({ canceled: false, path: 'C:\\out\\slice.gcode' }));
    const writeFile = vi.fn(async () => {});
    const { adapter } = setup({ saveFileDialog, writeFile });
    await adapter.exports.save('output.gcode', Uint8Array.from([3, 4]));
    expect(saveFileDialog).toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledWith('C:\\out\\slice.gcode', expect.any(ArrayBuffer));
  });

  it('does not write when export is cancelled', async () => {
    const writeFile = vi.fn();
    const { adapter } = setup({ saveFileDialog: vi.fn(async () => ({ canceled: true, path: null })), writeFile });
    await adapter.exports.save('output.gcode', Uint8Array.from([3]));
    expect(writeFile).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'win32'])('supplies correct brand-bar props for %s', async (platform) => {
    const { adapter } = setup({ platform });
    expect(adapter.chrome).toMatchObject({ kind: 'desktop', platform, dragRegion: true, macSafeInset: platform === 'darwin' });
  });

  it('falls back to in-memory preferences when legacy AppConfig fails', async () => {
    const load = vi.fn(async () => { throw new Error('unavailable'); });
    const save = vi.fn(async () => { throw new Error('unavailable'); });
    const { adapter } = setup({ appConfig: { load, save } });
    const value = { version: 1 as const, selectedProfiles: { printer: 'P' }, ui: { sidebarWidth: 300 } };
    await adapter.preferences.save(value);
    await expect(adapter.preferences.load()).resolves.toEqual(value);
  });
});
