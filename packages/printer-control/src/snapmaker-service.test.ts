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

describe('Snapmaker remaining print time', () => {
  function setup() {
    const f = fixture();
    const data = {
      stats: { state: 'printing', filename: 'folder/test #1.gcode', total_duration: 20 },
      sd: { file_position: 350 as unknown, progress: .9 },
      metadata: { gcode_start_byte: 100, gcode_end_byte: 1100, estimated_time: 101.5 } as Record<string, unknown>,
      metadataStatus: 200,
    };
    f.request.mockImplementation(async request => ({
      status: request.url.includes('/server/files/metadata?') ? data.metadataStatus : 200,
      json: async () => request.url.endsWith('/objects/list')
        ? { result: { objects: ['print_stats', 'virtual_sdcard', 'print_task_config'] } }
        : request.url.includes('/server/files/metadata?') ? { result: data.metadata }
          : { result: { status: { print_stats: data.stats, virtual_sdcard: data.sd,
            print_task_config: { filament_exist: [true], filament_type: ['PLA'] } } } },
    }));
    const read = async (service = f.snapmaker, target = f.target) => {
      const result = await service.observations.read({ target, source: 'device', topics: ['status'] });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      if (result.value.values.status.kind !== 'known') throw new Error('Expected printer status');
      return result.value.values.status.value.printStatus;
    };
    const metadataReads = () => f.request.mock.calls.filter(([request]) => request.url.includes('/server/files/metadata?'));
    return { ...f, data, read, metadataReads };
  }

  it.each([
    { position: 99, remaining: undefined },
    { position: 100, remaining: 101 },
    { position: 350, remaining: 76 },
    { position: 1100, remaining: 0 },
    { position: 1200, remaining: 0 },
    { position: undefined, remaining: undefined },
    { position: -1, remaining: undefined },
    { position: 100.5, remaining: undefined },
    { position: '350', remaining: undefined },
    { position: NaN, remaining: undefined },
  ])('estimates executable-byte progress at $position', async ({ position, remaining }) => {
    const f = setup();
    f.data.sd.file_position = position;
    expect((await f.read()).remainingSeconds).toMatchObject(remaining === undefined
      ? { kind: 'unknown' } : { kind: 'known', value: remaining });
  });

  it('reuses metadata through fresh facades and pause/resume, then refreshes on a new job or restart', async () => {
    const f = setup();
    expect((await f.read()).remainingSeconds).toMatchObject({ value: 76 });
    const request = f.metadataReads()[0][0];
    expect(request.url).toBe('http://printer/proxy/server/files/metadata?filename=folder%2Ftest%20%231.gcode');
    expect(request.headers).toMatchObject({ 'X-Api-Key': 'secret' });
    f.data.stats.state = 'paused';
    f.data.stats.total_duration = 30;
    f.data.sd.file_position = 600;
    expect((await f.read(createSnapmakerService(f.options))).remainingSeconds).toMatchObject({ value: 50 });
    f.data.stats.state = 'printing';
    await f.read();
    expect(f.metadataReads()).toHaveLength(1);
    f.data.stats.filename = 'second.gcode';
    f.data.metadata.estimated_time = 200;
    expect((await f.read()).remainingSeconds).toMatchObject({ value: 100 });
    expect(f.metadataReads()).toHaveLength(2);
    f.data.stats.total_duration = 1;
    f.data.metadata.estimated_time = 400;
    expect((await f.read()).remainingSeconds).toMatchObject({ value: 200 });
    expect(f.metadataReads()).toHaveLength(3);
    expect(f.request.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
  });

  it.each(['standby', 'complete', 'cancelled', 'error'])('clears the estimate for %s and reloads a repeated filename', async state => {
    const f = setup();
    await f.read();
    f.data.stats.state = state;
    expect((await f.read()).remainingSeconds).toMatchObject(state === 'complete'
      ? { kind: 'known', value: 0 } : { kind: 'unknown' });
    expect(f.metadataReads()).toHaveLength(1);
    f.data.stats.state = 'printing';
    await f.read();
    expect(f.metadataReads()).toHaveLength(2);
  });

  it.each([
    {}, { estimated_time: 0 }, { estimated_time: -1 }, { estimated_time: Infinity }, { estimated_time: '100' },
    { gcode_start_byte: -1 }, { gcode_start_byte: 100.5 }, { gcode_start_byte: null },
    { gcode_end_byte: 100 }, { gcode_end_byte: 50 }, { gcode_end_byte: NaN },
  ])('keeps invalid or unavailable metadata unknown and retries $0', async invalid => {
    const f = setup();
    f.data.metadata = Object.keys(invalid).length ? { ...f.data.metadata, ...invalid } : {};
    expect((await f.read()).remainingSeconds).toMatchObject({ kind: 'unknown' });
    f.data.metadata = { gcode_start_byte: 100, gcode_end_byte: 1100, estimated_time: 200 };
    expect((await f.read()).remainingSeconds).toMatchObject({ kind: 'known', value: 150 });
    expect(f.metadataReads()).toHaveLength(2);
  });

  it('keeps status available after metadata failure and retries on the next refresh', async () => {
    const f = setup();
    f.data.metadataStatus = 503;
    expect(await f.read()).toMatchObject({ phase: { value: 'printing' }, remainingSeconds: { kind: 'unknown' } });
    f.data.metadataStatus = 200;
    expect((await f.read()).remainingSeconds).toMatchObject({ kind: 'known', value: 76 });
    expect(f.metadataReads()).toHaveLength(2);
  });

  it('publishes fresh estimates through polling and retains their stale cache provenance', async () => {
    const f = setup();
    const controller = new AbortController();
    const stream = f.snapmaker.observations.watch({ target: f.target, topics: ['status'] }, { signal: controller.signal })[Symbol.asyncIterator]();
    async function nextRemaining() {
      for (let count = 0; count < 4; count++) {
        const event = await stream.next();
        const status = event.value?.snapshot.values.status;
        if (status?.kind === 'known' && status.freshness === 'fresh') return status.value.printStatus.remainingSeconds;
      }
      throw new Error('Expected fresh print time');
    }
    try {
      expect(await nextRemaining()).toMatchObject({ kind: 'known', value: 76, freshness: 'fresh' });
      f.data.sd.file_position = 600;
      expect(await nextRemaining()).toMatchObject({ kind: 'known', value: 50, freshness: 'fresh' });
      expect(f.metadataReads()).toHaveLength(1);
    } finally { controller.abort(); await stream.return?.(); }
    const cache = await f.snapmaker.observations.read({ target: f.target, source: 'cache', topics: ['status'] });
    expect(cache).toMatchObject({ ok: true, value: { values: { status: { freshness: 'stale', value: {
      printStatus: { remainingSeconds: { kind: 'known', value: 50, freshness: 'stale' } },
    } } } } });
  });

  it('invalidates metadata after connection changes and leaves Moonraker status unchanged', async () => {
    const f = setup();
    await f.read();
    const doc = await f.configuration.load();
    await f.configuration.save({ ...doc, printers: doc.printers.map(printer => printer.driverId === 'snapmaker'
      ? { ...printer, apiBaseUrl: 'http://other-printer/' } : printer) });
    await f.read();
    expect(f.metadataReads()).toHaveLength(2);
    expect(f.metadataReads()[1][0].url).toContain('http://other-printer/server/files/metadata?');
    expect((await f.read(f.moonraker, { printerId: id('moonraker'), routeId: id('moonraker:moonraker') })).remainingSeconds).toMatchObject({ kind: 'unknown' });
    expect(f.metadataReads()).toHaveLength(2);
  });
});

describe('Snapmaker provider foundation', () => {
  it.each([
    { state: { main_state: 1, action_code: 1 }, stage: { code: '1:1', label: 'Homing' } },
    { state: { main_state: 1, action_code: 256 }, stage: { code: '1:256', label: 'Bed leveling' } },
    { state: { main_state: 1, action_code: 257 }, stage: { code: '1:257', label: 'Preheating bed' } },
    { state: { main_state: 1, action_code: 0 }, stage: { code: '1:0', label: 'Printing' } },
    { state: { main_state: 0, action_code: 0 }, stage: null },
    { state: { main_state: 1, action_code: 9999 }, stage: { code: '1:9999', label: 'Printing' } },
    { state: { main_state: 9999, action_code: 9999 }, stage: undefined },
    { state: { main_state: -1, action_code: 0 }, stage: undefined },
    { state: { main_state: '1', action_code: '257' }, stage: undefined },
    { state: undefined, stage: undefined },
  ])('acquires and normalizes U1 stage $state', async ({ state, stage }) => {
    const f = fixture();
    f.request.mockImplementation(async request => ({ status: 200, json: async () => request.url.endsWith('/objects/list')
      ? { result: { objects: ['print_stats', 'print_task_config', 'machine_state_manager'] } }
      : { result: { status: { print_stats: { state: 'printing' }, machine_state_manager: state,
        print_task_config: { filament_exist: [true], filament_type: ['PLA'], filament_color_rgba: ['080A0DFF'] } } } } }));
    const result = await f.snapmaker.observations.read({ target: f.target, source: 'device', topics: ['status'] });
    expect(result).toMatchObject({ ok: true, value: { values: { status: { value: { printStatus: {
      stage: stage === undefined ? { kind: 'unknown' } : { kind: 'known', value: stage },
    } } } } } });
    expect(f.request.mock.calls.some(([request]) => request.url.includes('/objects/query?') && request.url.includes('machine_state_manager'))).toBe(true);
  });

  it.each([
    { label: 'preparing', state: 'printing', info: { current_layer: 0, total_layer: 15 }, current: 0, total: 15 },
    { label: 'printing', state: 'printing', info: { current_layer: 7, total_layer: 15 }, current: 7, total: 15 },
    { label: 'completed', state: 'complete', info: { current_layer: 15, total_layer: 15 }, current: 15, total: 15 },
    { label: 'idle with retained layers', state: 'standby', info: { current_layer: 15, total_layer: 15 }, current: null, total: null },
    { label: 'missing', state: 'printing', info: undefined, current: null, total: null },
    { label: 'null', state: 'printing', info: { current_layer: null, total_layer: null }, current: null, total: null },
    { label: 'negative and zero', state: 'printing', info: { current_layer: -1, total_layer: 0 }, current: null, total: null },
    { label: 'fractional', state: 'printing', info: { current_layer: 1.5, total_layer: 15.5 }, current: null, total: null },
    { label: 'text', state: 'printing', info: { current_layer: '7', total_layer: '15' }, current: null, total: null },
  ])('normalizes $label layer observations for both HTTP agents', async ({ state, info, current, total }) => {
    const f = fixture();
    f.request.mockImplementation(async request => ({ status: 200, json: async () => request.url.endsWith('/objects/list')
      ? { result: { objects: ['print_stats', 'virtual_sdcard', 'print_task_config'] } }
      : { result: { status: { print_stats: { state, filename: 'acceptance.gcode', info }, virtual_sdcard: { progress: .5 },
        print_task_config: { filament_exist: [true, false, false, false], filament_type: ['PLA'], filament_color_rgba: ['080A0DFF'] } } } } }));
    for (const driver of ['snapmaker', 'moonraker'] as const) {
      const result = await f[driver].observations.read({ target: { printerId: id<'printer'>(driver), routeId: id<'route'>(`${driver}:${driver}`) },
        source: 'device', topics: ['status'] });
      expect(result.ok, JSON.stringify({ driver, result })).toBe(true);
      expect(result).toMatchObject({ ok: true, value: { values: { status: { value: { printStatus: {
        currentLayer: current === null ? { kind: 'unknown' } : { kind: 'known', value: current },
        totalLayers: total === null ? { kind: 'unknown' } : { kind: 'known', value: total },
      } } } } } });
    }
  });

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
      ? { result: { objects: ['gcode', 'print_task_config', 'extruder', 'extruder1', 'extruder2', 'extruder3'] } }
      : { result: { status: { gcode: { commands: { SET_PRINT_FILAMENT_CONFIG: {} } }, print_task_config: { filament_exist: [true, true, true, true] },
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
    expect(await f.snapmaker.describe(f.target)).toMatchObject({ ok: true, value: { capabilities: { commands: {
      'materials.configure': { kind: 'supported', constraints: Array.from({ length: 4 }, () => ({ actions: ['confirm'] })) },
    } } } });
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
      expect(await f.snapmaker.describe(f.target)).toMatchObject({ ok: true, value: { capabilities: { commands: {
        'materials.configure': { kind: model ? 'supported' : 'unsupported' },
      } } } });
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
