import { describe, it, expect, vi } from 'vitest';
import { createMoonrakerService, createSnapmakerService } from './service';
import { createPrinterService } from './providers';
import { normalizePrinterConfigurationDocument, type PrinterConfigurationDocument } from './configuration';
import type * as D from './domain';
import type { PrinterTransportRequest, PrinterTransportResponse } from './transport';

const id = <K extends string>(value: string) => value as D.Id<K>;
function fixture() {
  let doc: PrinterConfigurationDocument = normalizePrinterConfigurationDocument({ version: 1, printers: ['moonraker', 'snapmaker'].map(driverId => ({
    id: driverId, driverId, displayName: 'Same name', apiBaseUrl: 'http://printer/proxy', apiKey: 'secret', consoleUrl: '',
  })) });
  const configuration = { load: async () => structuredClone(doc), save: async (value: PrinterConfigurationDocument) => { doc = structuredClone(value); } };
  const request = vi.fn(async ({ url }: PrinterTransportRequest): Promise<PrinterTransportResponse> => ({ status: 200, json: async () => url.endsWith('/objects/list')
    ? { result: { objects: ['print_task_config', 'filament_motion_sensor e0_filament'] } }
    : { result: { status: { print_task_config: { filament_exist: [true, false], filament_type: ['PLA', 'PETG'], filament_color_rgba: ['ff0000ff'] },
      'filament_motion_sensor e0_filament': { enabled: true, filament_detected: false } } } } }));
  const options = { configuration, host: { id: id<'agent-host'>('host'), name: 'Host', execution: 'browser' as const }, transport: { request } };
  const snapmaker = createSnapmakerService(options), moonraker = createMoonrakerService(options);
  const target = { printerId: id<'printer'>('snapmaker'), routeId: id<'route'>('snapmaker:snapmaker') };
  return { configuration, request, snapmaker, moonraker, target, options };
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
    expect(descriptor.ok && descriptor.value.capabilities.submission.kind).toBe('supported');
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

it('shares prepared submissions across service facades and keeps upload-only free of job settings', async () => {
  const f = fixture();
  f.request.mockImplementation(async request => ({ status: 200, json: async () => request.url.endsWith('/objects/list')
    ? { result: { objects: ['print_task_config', 'extruder'] } }
    : request.url.endsWith('/gcode/help') ? { result: { SET_PRINT_EXTRUDER_MAP: '', SET_PRINT_USED_EXTRUDERS: '', SET_PRINT_PREFERENCES: '' } }
      : request.url.includes('/objects/query?') ? { result: { status: { print_task_config: { filament_exist: [true], filament_type: ['PLA'] }, extruder: { nozzle_diameter: .4, nozzle_volume_type: 'standard' } } } }
        : request.body?.kind === 'multipart' ? { item: { root: 'gcodes', path: 'unchanged.gcode' } } : { result: 'ok' } }));
  const request: D.PrintPreparationRequest = { target: f.target, options: {}, suggest: true, bindings: [], allowAbnormalStorage: false,
    requirements: { contentId: 'receipt', plateId: 'plate', printerModel: 'Snapmaker U1', printerModelId: 'U1', materials: [{ key: 'filament-5', index: 5, toolIndex: 0, type: 'PLA', color: '#ff0000', brand: 'Generic', presetId: 'pla', presetName: 'PLA', nozzleDiameter: .4, nozzleFlowType: 'Standard', nozzleTemperature: 210, initialLayerNozzleTemperature: 215, chamberTemperature: 0, softeningTemperature: 55, requiredNozzleHardness: 0, usedGrams: 1, usedMeters: 1 }],
      nozzleDiameters: [.4, .4, .4, .4], nozzleFlowTypes: [], filamentMap: [1, 1, 1, 1, 1, 1], requiresDynamicMapping: false, bedType: 'plate', durationSeconds: 60, layerCount: 10, weightGrams: 1, timelapseWarningCode: 0, toolpathOutside: false, warnings: [] } };
  const prepared = await f.snapmaker.submissions.prepare(request);
  if (!prepared.ok) throw new Error(prepared.error.message);
  const sent = await f.snapmaker.submissions.submit({ ...request, bindings: prepared.value.bindings, jobName: 'Print', requestId: id('submit'), acknowledgedIssues: prepared.value.issues.filter(i => i.severity === 'warning').map(i => i.id) },
    [{ role: 'print', fileName: 'unchanged.gcode', sizeBytes: 3, chunks: (async function* () { yield new Uint8Array([255, 0, 10]); })() }]);
  if (!sent.ok) throw new Error(sent.error.message);
  const reopened = createSnapmakerService(f.options);
  const states = []; for await (const state of reopened.submissions.watch(sent.value)) states.push(state);
  expect(states.at(-1)?.phase).toBe('sent');
  f.request.mockClear();
  const uploaded = await reopened.files.upload({ target: f.target, requestId: id('upload-only'), destination: { kind: 'default' }, format: 'gcode', collisionPolicy: 'overwrite', fileName: 'unchanged.gcode', sizeBytes: 3 }, { chunks: (async function* () { yield new Uint8Array([255, 0, 10]); })() });
  if (uploaded.kind !== 'recorded') throw new Error('Expected upload');
  for await (const _state of reopened.operations.watch(uploaded.operation)) { /* drain */ }
  expect(f.request.mock.calls).toHaveLength(1);
  expect(f.request.mock.calls[0][0].url).toContain('/server/files/upload');
});
