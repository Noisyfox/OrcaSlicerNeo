import { describe, it, expect, vi } from 'vitest';
import { createMoonrakerService, createSnapmakerService } from './service';
import { createPrinterService } from './providers';
import { normalizePrinterConfigurationDocument, type PrinterConfigurationDocument } from './configuration';
import type * as D from './domain';

const id = <K extends string>(value: string) => value as D.Id<K>;
function fixture() {
  let doc: PrinterConfigurationDocument = normalizePrinterConfigurationDocument({ version: 1, printers: ['moonraker', 'snapmaker'].map(driverId => ({
    id: driverId, driverId, displayName: 'Same name', apiBaseUrl: 'http://printer/proxy', apiKey: 'secret', consoleUrl: '',
  })) });
  const configuration = { load: async () => structuredClone(doc), save: async (value: PrinterConfigurationDocument) => { doc = structuredClone(value); } };
  const request = vi.fn(async ({ url }: { url: string }) => ({ status: 200, json: async () => url.endsWith('/objects/list')
    ? { result: { objects: ['print_task_config', 'filament_motion_sensor e0_filament'] } }
    : { result: { status: { print_task_config: { filament_exist: [true, false], filament_type: ['PLA', 'PETG'], filament_color_rgba: ['ff0000ff'] },
      'filament_motion_sensor e0_filament': { enabled: true, filament_detected: false } } } } }));
  const options = { configuration, host: { id: id<'agent-host'>('host'), name: 'Host', execution: 'browser' as const }, transport: { request } };
  const snapmaker = createSnapmakerService(options), moonraker = createMoonrakerService(options);
  const target = { printerId: id<'printer'>('snapmaker'), routeId: id<'route'>('snapmaker:snapmaker') };
  return { configuration, request, snapmaker, moonraker, target };
}

describe('Snapmaker provider foundation', () => {
  it('isolates routes without probing on enumeration and preserves both providers during edits', async () => {
    const f = fixture();
    const service = createPrinterService([{ id: id('moonraker'), name: 'Moonraker', printers: f.moonraker }, { id: id('snapmaker'), name: 'Snapmaker', printers: f.snapmaker }]);
    const devices = await service.listSaved();
    expect(devices.ok && devices.value.map(p => p.routes[0].providerId)).toEqual(['moonraker', 'snapmaker']);
    expect(f.request).not.toHaveBeenCalled();
    expect((await f.moonraker.describe(f.target)).ok).toBe(false);
    await Promise.all([f.snapmaker.rename(f.target, 'U1'), f.moonraker.rename({ printerId: id('moonraker'), routeId: id('moonraker:moonraker') }, 'Other')]);
    expect((await f.configuration.load()).printers.map(p => p.displayName)).toEqual(['Other', 'U1']);
    const descriptor = await f.snapmaker.describe(f.target);
    expect(descriptor.ok && descriptor.value.capabilities.commands['jobs.start'].kind).toBe('unsupported');
    expect(descriptor.ok && descriptor.value.capabilities.submission.kind).toBe('unsupported');
  });

  it('keeps inserted-but-unloaded, empty and unreported materials distinct', async () => {
    const f = fixture();
    const result = await f.snapmaker.observations.read({ target: f.target, source: 'device', topics: ['materials'] });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.values.materials.kind !== 'known') throw new Error('Expected inventory');
    const state = result.value.values.materials.value.state;
    expect(state.slots[0].presence).toMatchObject({ kind: 'known', value: 'present' });
    expect(state.tools[0].loadedPathId).toMatchObject({ kind: 'known', value: null });
    expect(state.slots[1].presence).toMatchObject({ kind: 'known', value: 'empty' });
    expect(state.slots[1].material).toMatchObject({ kind: 'known', value: null });
    expect(state.slots[2].presence.kind).toBe('unknown');
    expect(state.tools[2].loadedPathId.kind).toBe('unknown');
    expect(f.request.mock.calls[1][0].url).toContain('/proxy/printer/objects/query?print_task_config&filament_motion_sensor%20e0_filament');
    const cached = await f.snapmaker.observations.read({ target: f.target, source: 'cache', topics: ['materials'] });
    expect(cached.ok && cached.value.values.materials).toMatchObject({ freshness: 'stale' });
    if (!cached.ok || cached.value.values.materials.kind !== 'known') throw new Error('Expected cached inventory');
    expect(cached.value.values.materials.value.state.slots[0].presence).toMatchObject({ freshness: 'stale' });
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it('reports missing protocol objects as unsupported rather than an empty successful inventory', async () => {
    const f = fixture();
    f.request.mockImplementation(async () => ({ status: 200, json: async () => ({ result: { objects: [] } }) }));
    const result = await f.snapmaker.observations.read({ target: f.target, source: 'device', topics: ['materials'] });
    expect(result).toMatchObject({ ok: false, error: { code: 'unsupported' } });
  });
});
