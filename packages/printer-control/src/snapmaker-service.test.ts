import { describe, it, expect, vi } from 'vitest';
import { createMoonrakerService, createSnapmakerService } from './service';
import { createPrinterService } from './providers';
import { readSynchronizationSource } from './synchronization';
import { normalizePrinterConfigurationDocument, type PrinterConfigurationDocument } from './configuration';
import type * as D from './domain';
import type { PrinterTransportRequest, PrinterTransportResponse } from './transport';

const id = <K extends string>(value: string) => value as D.Id<K>;
function fixture(matchFilaments?: import('./snapmaker-observation').FilamentMatcher) {
  let doc: PrinterConfigurationDocument = normalizePrinterConfigurationDocument({ version: 1, printers: ['moonraker', 'snapmaker'].map(driverId => ({
    id: driverId, driverId, displayName: 'Same name', apiBaseUrl: 'http://printer/proxy', apiKey: 'secret', consoleUrl: '',
  })) });
  const configuration = { load: async () => structuredClone(doc), save: async (value: PrinterConfigurationDocument) => { doc = structuredClone(value); } };
  const request = vi.fn(async ({ url }: PrinterTransportRequest): Promise<PrinterTransportResponse> => ({ status: 200, json: async () => url.endsWith('/objects/list')
    ? { result: { objects: ['print_task_config', 'filament_motion_sensor e0_filament'] } }
    : { result: { status: { print_task_config: { filament_exist: [true, false], filament_type: ['PLA', 'PETG'], filament_color_rgba: ['ff0000ff'] },
      'filament_motion_sensor e0_filament': { enabled: true, filament_detected: false } } } } }));
  const options = { configuration, matchFilaments, host: { id: id<'agent-host'>('host'), name: 'Host', execution: 'browser' as const }, transport: { request } };
  const snapmaker = createSnapmakerService(options), moonraker = createMoonrakerService(options);
  const target = { printerId: id<'printer'>('snapmaker'), routeId: id<'route'>('snapmaker:snapmaker') };
  return { configuration, request, snapmaker, moonraker, target, options };
}

describe('Snapmaker provider foundation', () => {
  it('publishes native matching results through live and cached material observations', async () => {
    const matcher = vi.fn(async () => ['native-filament-id']);
    const f = fixture(matcher);
    const result = await f.snapmaker.observations.read({ target: f.target, source: 'device', topics: ['materials'] });
    expect(matcher).toHaveBeenCalledWith([{ presetName: null, manufacturer: '', materialType: 'PLA', colorRgba: '#ff0000ff' }]);
    expect(result).toMatchObject({ ok: true, value: { values: { materials: { value: { state: { slots: [
      { material: { value: { catalogRefs: [{ namespace: 'orca-filament', value: 'native-filament-id' }] } } },
      { material: { value: null } }, {}, {},
    ] } } } } } });
    const cache = await f.snapmaker.observations.read({ target: f.target, source: 'cache', topics: ['materials'] });
    expect(cache).toMatchObject({ ok: true, value: { values: { materials: { value: { state: { slots: [
      { material: { value: { catalogRefs: [{ namespace: 'orca-filament', value: 'native-filament-id' }] } } }, {}, {}, {},
    ] } } } } } });
  });
  it('uses the latest Device model selection in an already running observation stream', async () => {
    const f = fixture();
    const doc = await f.configuration.load();
    await f.configuration.save({ ...doc, printers: doc.printers.map(p => p.driverId === 'snapmaker'
      ? { ...p, printerModel: { vendorId: 'Snapmaker', model: 'Snapmaker U1' } } : p) });
    const controller = new AbortController();
    const stream = f.snapmaker.observations.watch({ target: f.target, topics: ['descriptor'] }, { signal: controller.signal })[Symbol.asyncIterator]();
    const nextModel = async () => {
      for (let i = 0; i < 3; i++) {
        const event = await stream.next();
        const reading = event.value?.snapshot.values.descriptor;
        if (reading?.kind === 'known' && reading.freshness === 'fresh') return reading.value.identity.model;
      }
      throw new Error('No fresh descriptor');
    };
    try {
      expect(await nextModel()).toBe('Snapmaker U1');
      const current = await f.configuration.load();
      await f.configuration.save({ ...current, printers: current.printers.map(p => p.driverId === 'snapmaker'
        ? { ...p, printerModel: { vendorId: 'Manual', model: 'New selection' } } : p) });
      expect(await nextModel()).toBe('New selection');
    } finally { controller.abort(); await stream.return?.(); }
  });
  it('reports the Device model selection to Printer sync and follows changes without hardware inference', async () => {
    const f = fixture();
    f.request.mockImplementation(async ({ url }) => ({ status: 200, json: async () => url.endsWith('/objects/list')
      ? { result: { objects: ['print_task_config', 'extruder', 'extruder1', 'extruder2', 'extruder3'] } }
      : { result: { status: { print_task_config: { filament_exist: [true, true, true, true] },
        ...Object.fromEntries(['extruder', 'extruder1', 'extruder2', 'extruder3'].map(name => [name, { nozzle_diameter: .4, nozzle_volume_type: 'standard' }])) } } } }));
    const doc = await f.configuration.load();
    await f.configuration.save({ ...doc, printers: doc.printers.map(p => p.driverId === 'snapmaker'
      ? { ...p, printerModel: { vendorId: 'Snapmaker', model: 'Snapmaker U1' } } : p) });
    const saved = await f.snapmaker.listSaved();
    if (!saved.ok) throw new Error('Expected saved printer');
    const printer = saved.value[0];
    expect(printer.configuredModel).toEqual({ vendorId: 'Snapmaker', model: 'Snapmaker U1' });
    expect(printer.identity.model).toBeNull();
    const source = await readSynchronizationSource(f.snapmaker, printer, printer.routes[0], 'printer', { refresh: true });
    expect(source).toMatchObject({ ok: true, value: {
      identity: { manufacturer: 'Snapmaker', model: 'Snapmaker U1' },
      tools: Array.from({ length: 4 }, () => ({ diameterMm: .4 })),
    } });
    for (const model of [{ vendorId: 'Other vendor', model: 'Other model' }, undefined]) {
      const current = await f.configuration.load();
      await f.configuration.save({ ...current, printers: current.printers.map(p => {
        if (p.driverId !== 'snapmaker') return p;
        const { printerModel: _previous, ...rest } = p;
        return model ? { ...rest, printerModel: model } : rest;
      }) });
      const updated = await readSynchronizationSource(f.snapmaker, printer, printer.routes[0], 'printer', { refresh: true });
      expect(updated).toMatchObject({ ok: true, value: { identity: {
        manufacturer: model?.vendorId ?? null, model: model?.model ?? null,
      } } });
    }
    expect(f.request.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
  });
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
    ? { result: { objects: ['gcode', 'print_task_config', 'extruder'] } }
      : request.url.includes('/objects/query?') ? { result: { status: { gcode: { commands: { SET_PRINT_EXTRUDER_MAP: {}, SET_PRINT_USED_EXTRUDERS: {}, SET_PRINT_PREFERENCES: {} } }, print_task_config: { filament_exist: [true], filament_type: ['PLA'] }, extruder: { nozzle_diameter: .4, nozzle_volume_type: 'standard' } } } }
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
  const writes = f.request.mock.calls.filter(([r]) => r.method === 'POST');
  expect(writes).toHaveLength(1);
  expect(writes[0][0].url).toContain('/server/files/upload');
});


it('retains one individual load operation across observers and rejects a second without queuing', async () => {
  const f = fixture(); let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  f.request.mockImplementation(async request => {
    if (request.method === 'POST') await wait;
    return { status: 200, json: async () => request.url.endsWith('/objects/list') ? { result: { objects: ['gcode', 'print_task_config', 'filament_feed left', 'filament_feed right'] } }
        : request.method === 'POST' ? { result: 'ok' } : { result: { status: { gcode: { commands: { FEED_AUTO: {} } }, print_task_config: { filament_exist: [true] } } } } };
  });
  const first = await f.snapmaker.controls.submit({ target: f.target, requestId: id('load-1'), command: { type: 'materials.load', params: { pathId: id('snapmaker-path:0') } } });
  expect(first.kind).toBe('recorded');
  const reopened = createSnapmakerService(f.options);
  const second = await reopened.controls.submit({ target: f.target, requestId: id('load-2'), command: { type: 'materials.unload', params: { toolId: id('snapmaker-tool:1') } } });
  expect(second).toMatchObject({ kind: 'rejected', error: { code: 'busy' } });
  finish();
  if (first.kind !== 'recorded') throw new Error('Expected command');
  const phases = []; for await (const operation of reopened.operations.watch(first.operation)) phases.push(operation.phase.kind);
  expect(phases.at(-1)).toBe('acknowledged');
  expect(f.request.mock.calls.filter(([r]) => r.method === 'POST')).toHaveLength(1);
});


it('saves preferences with fresh comparison and readback, and retains partial effects on mismatch', async () => {
  const f = fixture(); let autoRefill = false, ignoreColor = false;
  const scripts: string[] = [];
  f.request.mockImplementation(async request => {
    if (request.method === 'POST' && request.body?.kind === 'json') {
      const script = (JSON.parse(request.body.json) as { script: string }).script; scripts.push(script);
      if (script.includes('AUTO_REPLENISH_FILAMENT=1')) autoRefill = true;
      // Simulate an ACK which failed to apply the color preference.
    }
    return { status: 200, json: async () => request.url.endsWith('/objects/list') ? { result: { objects: ['gcode', 'print_task_config'] } }
        : request.method === 'POST' ? { result: 'ok' } : { result: { status: { gcode: { commands: { SET_PRINT_PREFERENCES: {} } }, print_task_config: { auto_replenish_filament: autoRefill, replenish_ignore_color: ignoreColor } } } } };
  });
  async function save(key: 'autoRefill' | 'allowDifferentColors') {
    const submitted = await f.snapmaker.controls.submit({ target: f.target, requestId: id(crypto.randomUUID()), command: { type: 'preferences.set', params: { changes: [{ key, value: true }] } } });
    if (submitted.kind !== 'recorded') throw new Error('Expected command');
    const phases = []; for await (const operation of f.snapmaker.operations.watch(submitted.operation)) phases.push(operation.phase);
    return phases.at(-1);
  }
  expect(await save('autoRefill')).toMatchObject({ kind: 'acknowledged' });
  expect(await save('allowDifferentColors')).toMatchObject({ kind: 'failed', error: { code: 'device-failed' } });
  expect(autoRefill).toBe(true);
  expect(scripts).toEqual(['SET_PRINT_PREFERENCES AUTO_REPLENISH_FILAMENT=1', 'SET_PRINT_PREFERENCES REPLENISH_IGNORE_COLOR=1']);
});
