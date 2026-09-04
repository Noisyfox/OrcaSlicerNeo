import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserAdapter, createBrowserPrinterConfigurationRepository, createBrowserProfileSource, downloadGcode, downloadProject, pickProject, PRINTER_CONFIGURATION_STORAGE_KEY, SOURCE_URL } from './browserAdapter';

const runtimeLoad = vi.hoisted(() => ({ count: 0 }));

// The runtime root also exports the Worker-backed client. Mock only that
// entrypoint's profile exports so this adapter suite remains Worker-free while
// exercising the actual shared profile implementation.
vi.mock('@orca/slicer-runtime', async () => {
  runtimeLoad.count += 1;
  return import('../../../packages/slicer-runtime/src/profiles');
});

describe('browser adapter', () => {
  beforeEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  it('uses a file input for model selection', async () => {
    const input = document.createElement('input');
    Object.defineProperty(input, 'files', { value: [{ name: 'cube.stl', arrayBuffer: async () => new Uint8Array([1, 2]).buffer }] });
    const click = vi.spyOn(input, 'click').mockImplementation(() => input.dispatchEvent(new Event('change')));
    vi.spyOn(document, 'createElement').mockReturnValue(input);
    const result = await createBrowserAdapter({} as never).models.pick();
    expect(click).toHaveBeenCalled();
    expect(input.accept).toBe('.stl,.3mf,.drc');
    expect(result?.displayName).toBe('cube.stl');
    expect([...result!.bytes]).toEqual([1, 2]);
  });

  it('downloads gcode through a Blob URL', async () => {
    const anchor = document.createElement('a');
    const click = vi.spyOn(anchor, 'click').mockImplementation(() => undefined);
    vi.spyOn(document, 'createElement').mockReturnValue(anchor);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    await downloadGcode('cube', new Uint8Array([71, 49]));
    expect(anchor.download).toBe('cube.gcode');
    expect(anchor.href).toContain('blob:test');
    expect(click).toHaveBeenCalled();
  });

  it('uses a dedicated .3mf picker for projects without changing the model picker', async () => {
    const input = document.createElement('input');
    Object.defineProperty(input, 'files', { value: [{ name: 'scene.3mf', arrayBuffer: async () => Uint8Array.from([7, 8]).buffer }] });
    const click = vi.spyOn(input, 'click').mockImplementation(() => input.dispatchEvent(new Event('change')));
    vi.spyOn(document, 'createElement').mockReturnValue(input);
    await expect(pickProject()).resolves.toMatchObject({ displayName: 'scene.3mf', bytes: Uint8Array.from([7, 8]) });
    expect(click).toHaveBeenCalled();
    expect(input.accept).toBe('.3mf');
  });

  it('propagates project file read failures so the adapter can report failed', async () => {
    const input = document.createElement('input');
    Object.defineProperty(input, 'files', { value: [{ name: 'broken.3mf', arrayBuffer: async () => { throw new Error('read failed'); } }] });
    vi.spyOn(input, 'click').mockImplementation(() => input.dispatchEvent(new Event('change')));
    vi.spyOn(document, 'createElement').mockReturnValue(input);
    await expect(createBrowserAdapter({} as never).projects.open()).resolves.toMatchObject({ status: 'failed' });
  });

  it('downloads a new .3mf project on every save and retains no location', async () => {
    const anchor = document.createElement('a');
    const click = vi.spyOn(anchor, 'click').mockImplementation(() => undefined);
    vi.spyOn(document, 'createElement').mockReturnValue(anchor);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:project');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const adapter = createBrowserAdapter({} as never);
    const input = { displayName: 'scene', bytes: Uint8Array.from([1, 2]) };
    await expect(adapter.projects.save(input)).resolves.toEqual({ status: 'ok' });
    await downloadProject(input);
    expect(anchor.download).toBe('scene.3mf');
    expect(click).toHaveBeenCalledTimes(2);
    expect(input).not.toHaveProperty('location');
  });

  it('supplies browser menu mode and opens only the fixed source URL', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const adapter = createBrowserAdapter({} as never);
    expect(adapter.chrome.menuMode).toBe('browser');
    expect(adapter.menu.syncModel({ version: 1, menuMode: 'browser', menus: [] })).toBeUndefined();
    adapter.externalLinks.openSource();
    expect(open).toHaveBeenCalledWith(SOURCE_URL, '_blank', 'noopener,noreferrer');
  });

  it('resolves built profile assets beside the deployment root, not under assets', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3])),
    );
    const source = createBrowserProfileSource('./', 'https://host.test/orca/assets/browser.js');
    expect(runtimeLoad.count).toBe(0);

    await expect(source.fetch('manifest.json')).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(runtimeLoad.count).toBe(1);
    expect(String(request.mock.calls[0]?.[0])).toBe('https://host.test/orca/profiles/manifest.json');
  });

  it('returns an empty document for missing, corrupt, or non-compliant storage', async () => {
    const repository = createBrowserPrinterConfigurationRepository();
    await expect(repository.load()).resolves.toEqual({ version: 1, printers: [] });
    localStorage.setItem(PRINTER_CONFIGURATION_STORAGE_KEY, '{bad json');
    await expect(repository.load()).resolves.toEqual({ version: 1, printers: [] });
    localStorage.setItem(PRINTER_CONFIGURATION_STORAGE_KEY, JSON.stringify({ version: 2, printers: [] }));
    await expect(repository.load()).resolves.toEqual({ version: 1, printers: [] });
  });

  it('round-trips multiple records and retains complete API keys', async () => {
    const repository = createBrowserPrinterConfigurationRepository();
    const document = { version: 1 as const, printers: [
      { id: 'p1', displayName: 'First', driverId: 'moonraker' as const, consoleUrl: 'http://one.local/', apiBaseUrl: 'http://one.local:7125/', apiKey: 'key-one-complete' },
      { id: 'p2', displayName: 'Second', driverId: 'moonraker' as const, consoleUrl: 'https://two.local/ui', apiBaseUrl: 'https://two.local/api', apiKey: 'key-two-complete' },
    ] };
    await repository.save(document);
    expect(JSON.parse(localStorage.getItem(PRINTER_CONFIGURATION_STORAGE_KEY)!)).toEqual(document);
    await expect(repository.load()).resolves.toEqual(document);
  });
});
