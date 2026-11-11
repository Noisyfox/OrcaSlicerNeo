import { describe, it, expect, vi } from 'vitest';
import { createMoonrakerService } from '../service';
import { createSnapmakerService } from './service';
import { createPrinterService } from '../providers';
import { readSynchronizationSource } from '../synchronization';
import { U1CameraMedia, U1_CAMERA_ID } from './camera';
import { normalizePrinterConfigurationDocument, type PrinterConfigurationDocument } from '../configuration';
import type * as D from '../domain';
import type { PrinterTransportRequest, PrinterTransportResponse } from '../transport';

const id = <K extends string>(value: string) => value as D.Id<K>;

it('switches and parks physical U1 tools once, confirms sensors, and restores extrusion state after failure', async () => {
  let active = 0, failExtrusion = false;
  const scripts: string[] = [];
  const configuration = { load: async () => normalizePrinterConfigurationDocument({ version: 1, printers: [
    { id: 'u1', driverId: 'snapmaker', displayName: 'U1', apiBaseUrl: 'http://fixture/', apiKey: '', consoleUrl: '' },
  ] }), save: async () => {} };
  const transport = { request: async (request: PrinterTransportRequest): Promise<PrinterTransportResponse> => {
    let result: unknown;
    if (request.method === 'POST') {
      const script = JSON.parse(request.body?.kind === 'json' ? request.body.json : '{}').script as string;
      scripts.push(script);
      if (script === 'T1 A0') active = 1;
      if (script === 'PARK_EXTRUDER1') active = -1;
      if (failExtrusion && script.startsWith('M83')) return { status: 400, json: async () => ({}), bytes: async () => new Uint8Array() };
      result = 'ok';
    } else if (request.url.endsWith('/objects/list')) result = { objects: ['gcode', 'toolhead', 'print_stats', 'machine_state_manager', 'configfile', 'extruder', 'extruder1'] };
    else {
      const real = [active === 1 ? 'extruder1' : 'extruder', active < 0 ? 1 : 0];
      result = { status: { gcode: { commands: Object.fromEntries(['T0', 'T1', 'PARK_EXTRUDER1', 'SAVE_GCODE_STATE', 'RESTORE_GCODE_STATE', 'M83', 'M220', 'M221', 'G1', 'M400'].map(command => [command, {}])) },
        print_stats: { state: 'standby' }, machine_state_manager: { main_state: 0, action_code: 0 },
        toolhead: { extruder: active === 1 ? 'extruder1' : 'extruder' },
        extruder: { real_extruder_stats: real, activating_move: false, can_extrude: true },
        extruder1: { real_extruder_stats: real, activating_move: false, can_extrude: true },
        configfile: { settings: { extruder1: { max_extrude_only_distance: 50 } } } } };
    }
    return { status: 200, json: async () => ({ result }), bytes: async () => new Uint8Array() };
  } };
  const service = createSnapmakerService({ configuration, transport, host: { id: id('test'), name: 'Test', execution: 'browser' } });
  const target = { printerId: id<'printer'>('u1'), routeId: id<'route'>('snapmaker:u1') };
  const finish = async (submission: D.Submission) => {
    if (submission.kind !== 'recorded') throw new Error(submission.kind);
    let result: D.PrinterOperation | undefined;
    for await (const next of service.operations.watch(submission.operation)) result = next;
    return result;
  };
  const request = { target, requestId: id<'request'>('switch'), command: { type: 'tools.select' as const, params: { toolId: id<'tool'>('snapmaker-tool:1') } } };
  expect((await finish(await service.controls.submit(request)))?.phase.kind).toBe('completed');
  await service.controls.submit(request);
  expect(scripts).toEqual(['T1 A0']);
  expect(await service.observations.read({ target, topics: ['status'], source: 'device' })).toMatchObject({ ok: true, value: { values: { status: { value: { activeToolIds: { value: ['snapmaker-tool:1'] } } } } } });
  failExtrusion = true;
  const extrusion = await service.controls.submit({ target, requestId: id('extrude'), command: { type: 'extrusion.move', params: { extruderId: id('snapmaker-extruder:1'), distanceMm: 10, speed: { kind: 'specified', mmPerSecond: 5 } } } });
  expect((await finish(extrusion))?.phase.kind).toBe('failed');
  expect(scripts.slice(-3)).toEqual(['SAVE_GCODE_STATE NAME=orca_device_extrusion', 'M83\nM220 S100\nM221 S100\nG1 E10 F300\nM400', 'RESTORE_GCODE_STATE NAME=orca_device_extrusion']);
  const unconfirmed = { target, requestId: id<'request'>('unconfirmed'), command: { type: 'tools.select' as const, params: { toolId: id<'tool'>('snapmaker-tool:0') } } };
  expect((await finish(await service.controls.submit(unconfirmed)))?.phase.kind).toBe('outcome-unknown');
  await service.controls.submit(unconfirmed);
  expect(scripts.filter(script => script === 'T0 A0')).toHaveLength(1);
  expect((await finish(await service.controls.submit({ target, requestId: id('park'), command: { type: 'tools.park', params: { toolId: id('snapmaker-tool:1') } } })))?.phase.kind).toBe('completed');
  expect(await service.observations.read({ target, topics: ['status'], source: 'device' })).toMatchObject({ ok: true, value: { values: { status: { value: { activeToolIds: { value: [] } } } } } });
});

it('advertises host-bound camera support without probing or changing other agents', async () => {
  const f = fixture(), create = vi.fn(() => { throw new Error('Unexpected socket'); });
  let owner: U1CameraMedia | undefined;
  const service = createSnapmakerService({ ...f.options, camera: resolve => {
    owner = new U1CameraMedia({ resolve, http: f.options.transport, sockets: { create } }); return owner.api;
  } });
  try {
    expect(await service.describe(f.target)).toMatchObject({ ok: true, value: { capabilities: { cameras: [{ cameraId: U1_CAMERA_ID, liveView: { kind: 'supported' } }] } } });
    expect(f.request).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    expect(await f.moonraker.describe({ ...f.target, printerId: id<'printer'>('moonraker'), routeId: id<'route'>('moonraker:moonraker') }))
      .toMatchObject({ ok: true, value: { capabilities: { cameras: [] } } });
    const observed = await service.observations.read({ target: f.target, source: 'device', topics: ['descriptor'] });
    expect(observed).toMatchObject({ ok: true, value: { values: { descriptor: { value: { topology: { cameras: [{ id: U1_CAMERA_ID, role: 'chamber' }] } } } } } });
    expect(create).not.toHaveBeenCalled();
  } finally { await owner?.dispose(); }
});
function fixture(matchFilaments?: import('./observation').FilamentMatcher) {
  let doc: PrinterConfigurationDocument = normalizePrinterConfigurationDocument({ version: 1, printers: ['moonraker', 'snapmaker'].map(driverId => ({
    id: driverId, driverId, displayName: 'Same name', apiBaseUrl: 'http://printer/proxy', apiKey: 'secret', consoleUrl: '',
  })) });
  const configuration = { load: async () => structuredClone(doc), save: async (value: PrinterConfigurationDocument) => { doc = structuredClone(value); } };
  const request = vi.fn(async ({ url }: PrinterTransportRequest): Promise<PrinterTransportResponse> => ({ status: 200, bytes: async () => { throw new Error('Unexpected binary read'); }, json: async () => url.endsWith('/objects/list')
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
      metadata: { gcode_start_byte: 100, gcode_end_byte: 1100, estimated_time: 101.5,
        job_id: '000001', print_start_time: 1234, uuid: 'file-version' } as Record<string, unknown>,
      metadataStatus: 200,
    };
    f.request.mockImplementation(async request => ({
      status: request.url.includes('/server/files/metadata?') ? data.metadataStatus : 200,
      bytes: async () => { throw new Error('Unexpected binary read'); }, json: async () => request.url.endsWith('/objects/list')
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

  it('retains zero remaining time when a completed job no longer reports a filename', async () => {
    const f = setup();
    f.data.stats.state = 'complete';
    f.data.stats.filename = '';
    expect((await f.read()).remainingSeconds).toMatchObject({ kind: 'known', value: 0 });
    expect(f.metadataReads()).toHaveLength(0);
  });

  it('keeps task identity through pause/completion and refreshes it for a repeated filename', async () => {
    const f = setup();
    const readTaskId = async () => {
      const task = (await f.read()).taskId;
      if (task.kind !== 'known') throw new Error('Expected current task identity');
      return task.value;
    };
    const first = await readTaskId();
    f.data.stats.state = 'paused';
    expect(await readTaskId()).toBe(first);
    f.data.stats.state = 'complete';
    expect(await readTaskId()).toBe(first);
    f.data.stats.state = 'printing';
    f.data.metadata.print_start_time = 5678;
    expect(await readTaskId()).not.toBe(first);
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

describe('Snapmaker current-task preview', () => {
  function setup() {
    const f = fixture();
    const data = {
      stats: { state: 'paused', filename: 'folder/测试 #1.gcode', total_duration: 20 },
      metadata: { job_id: '000009', print_start_time: 1234, uuid: 'file-version',
        thumbnails: [
          { width: 96, height: 96, relative_path: '.thumbs/测试 #1-96x96.png' },
          { width: 300, height: 300, relative_path: '.thumbs/测试 #1-300x300.png' },
        ] } as Record<string, unknown>,
      bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      imageStatus: 200,
      onImage: () => {},
    };
    f.request.mockImplementation(async request => {
      if (request.responseType === 'bytes') {
        data.onImage();
        return { status: data.imageStatus, bytes: async () => data.bytes, json: async () => { throw new Error('Unexpected JSON image read'); } };
      }
      const body = request.url.endsWith('/objects/list') ? { objects: ['print_stats', 'virtual_sdcard'] }
        : request.url.includes('/server/files/metadata?') ? structuredClone(data.metadata)
          : { status: { print_stats: { ...data.stats }, virtual_sdcard: {} } };
      return { status: 200, json: async () => ({ result: body }), bytes: async () => { throw new Error('Unexpected binary read'); } };
    });
    const preview = (service = f.snapmaker, target = f.target, signal?: AbortSignal) => service.media.readCurrentPrintPreview(target, { signal });
    return { ...f, data, preview };
  }

  it('reads the largest thumbnail with its exact task identity through the authenticated proxy', async () => {
    const f = setup();
    const observed = await f.snapmaker.observations.read({ target: f.target, topics: ['status'], source: 'device' });
    const result = await f.preview();
    expect(result).toMatchObject({ ok: true, value: { ...f.target, mimeType: 'image/png', bytes: f.data.bytes } });
    if (!result.ok) throw new Error('Missing image');
    expect(observed).toMatchObject({ ok: true, value: { values: { status: { value: { printStatus: { taskId: { kind: 'known', value: result.value.taskId } } } } } } });
    expect(f.request.mock.calls.find(([request]) => request.responseType === 'bytes')?.[0]).toMatchObject({
      method: 'GET', url: 'http://printer/proxy/server/files/gcodes/folder/.thumbs/%E6%B5%8B%E8%AF%95%20%231-300x300.png', headers: { 'X-Api-Key': 'secret' },
    });
    expect((await f.snapmaker.describe(f.target))).toMatchObject({ ok: true, value: { capabilities: { currentPrintPreview: { kind: 'supported' } } } });
    expect((await f.moonraker.media.readCurrentPrintPreview({ printerId: id('moonraker'), routeId: id('moonraker:moonraker') }))).toMatchObject({ ok: false, error: { code: 'unsupported' } });
    expect(f.request.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
  });

  it.each(['complete', 'cancelled', 'error'])('retains previews for the reported %s task', async state => {
    const f = setup();
    f.data.stats.state = state;
    expect(await f.preview()).toMatchObject({ ok: true });
  });

  it.each([
    { change: 'filename', apply: (f: ReturnType<typeof setup>) => { f.data.stats.filename = 'other.gcode'; } },
    { change: 'same-file restart', apply: (f: ReturnType<typeof setup>) => { f.data.metadata.print_start_time = 5678; } },
    { change: 'file replacement', apply: (f: ReturnType<typeof setup>) => { f.data.metadata.uuid = 'replaced'; } },
  ])('rejects a preview after $change', async ({ apply }) => {
    const f = setup();
    f.data.onImage = () => apply(f);
    expect(await f.preview()).toMatchObject({ ok: false, error: { code: 'stale-context' } });
  });

  it.each(['standby', ''])('leaves an absent current task unavailable for %s', async state => {
    const f = setup();
    f.data.stats.state = state;
    expect(await f.preview()).toMatchObject({ ok: false, error: { code: 'preview-unavailable' } });
    expect(f.request.mock.calls.some(([request]) => request.responseType === 'bytes')).toBe(false);
  });

  it.each([
    { thumbnails: [] },
    { thumbnails: [{ relative_path: '.thumbs/missing.png' }] },
    { thumbnails: [{ width: 300, height: 300, relative_path: '../secret.png' }] },
    { thumbnails: [{ width: 300, height: 300, relative_path: 'https://other-host/image.png' }] },
  ])('rejects missing or invalid thumbnail descriptors $thumbnails', async ({ thumbnails }) => {
    const f = setup();
    f.data.metadata.thumbnails = thumbnails;
    expect(await f.preview()).toMatchObject({ ok: false, error: { code: 'preview-unavailable' } });
    expect(f.request.mock.calls.some(([request]) => request.responseType === 'bytes')).toBe(false);
  });

  it.each([new Uint8Array(), new TextEncoder().encode('<html>error</html>'), new Uint8Array(4 * 1024 * 1024 + 1)])('rejects invalid image data', async bytes => {
    const f = setup();
    f.data.bytes = bytes;
    expect(await f.preview()).toMatchObject({ ok: false });
  });

  it('accepts JPEG data and reports authorization errors without exposing credentials', async () => {
    const f = setup();
    f.data.bytes = new Uint8Array([255, 216, 255, 224]);
    expect(await f.preview()).toMatchObject({ ok: true, value: { mimeType: 'image/jpeg' } });
    f.data.imageStatus = 401;
    expect(await f.preview()).toEqual({ ok: false, error: { code: 'authentication-required', message: 'Printer image is unavailable' } });
  });

  it('honors cancellation and rejects responses from a replaced connection', async () => {
    const f = setup();
    const abort = new AbortController();
    abort.abort();
    expect(await f.preview(f.snapmaker, f.target, abort.signal)).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(f.request).not.toHaveBeenCalled();
    f.data.onImage = () => {
      f.configuration.load = async () => normalizePrinterConfigurationDocument({ version: 1, printers: [{
        id: 'snapmaker', driverId: 'snapmaker', displayName: 'Changed', apiBaseUrl: 'http://other-printer', apiKey: '', consoleUrl: '',
      }] });
    };
    expect(await f.preview()).toMatchObject({ ok: false, error: { code: 'stale-context' } });
  });

  it('validates the newly published task identity before guarded cancel dispatch', async () => {
    const f = setup();
    const image = await f.preview();
    if (!image.ok) throw new Error('Missing task');
    const submit = () => f.snapmaker.controls.submit({ target: f.target, requestId: id(crypto.randomUUID()),
      command: { type: 'jobs.cancel', params: {} }, guard: { expectedTaskId: image.value.taskId } });
    f.data.metadata.print_start_time = 5678;
    expect(await submit()).toMatchObject({ kind: 'rejected', error: { code: 'stale-context' } });
    expect(f.request.mock.calls.some(([request]) => request.method === 'POST')).toBe(false);
    f.data.metadata.print_start_time = 1234;
    expect(await submit()).toMatchObject({ kind: 'recorded' });
    await vi.waitFor(() => expect(f.request.mock.calls.some(([request]) => request.method === 'POST')).toBe(true));
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
    f.request.mockImplementation(async request => ({ status: 200, bytes: async () => { throw new Error('Unexpected binary read'); }, json: async () => request.url.endsWith('/objects/list')
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
    f.request.mockImplementation(async request => ({ status: 200, bytes: async () => { throw new Error('Unexpected binary read'); }, json: async () => request.url.endsWith('/objects/list')
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
    f.request.mockImplementation(async ({ url }) => ({ status: 200, bytes: async () => { throw new Error('Unexpected binary read'); }, json: async () => url.endsWith('/objects/list')
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
    f.request.mockImplementation(async () => ({ status: 200, bytes: async () => { throw new Error('Unexpected binary read'); }, json: async () => ({ result: { objects: [] } }) }));
    const result = await f.snapmaker.observations.read({ target: f.target, source: 'device', topics: ['materials'] });
    expect(result).toMatchObject({ ok: false, error: { code: 'unsupported' } });
  });
});

it('shares polling across fresh Snapmaker facades and releases the final observation lease', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const reopened = createSnapmakerService(f.options);
  const firstAbort = new AbortController(), secondAbort = new AbortController();
  const first = f.snapmaker.observations.watch({ target: f.target, topics: ['materials'] }, { signal: firstAbort.signal })[Symbol.asyncIterator]();
  const second = reopened.observations.watch({ target: f.target, topics: ['materials'] }, { signal: secondAbort.signal })[Symbol.asyncIterator]();
  try {
    await first.next(); await second.next();
    expect((await reopened.observations.read({ target: f.target, source: 'device', topics: ['materials'] })).ok).toBe(true);
    f.request.mockClear();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.request).toHaveBeenCalledTimes(2);
    firstAbort.abort(); await first.return?.();
    f.request.mockClear();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.request).toHaveBeenCalledTimes(2);
    secondAbort.abort(); await second.return?.();
    const cached = await reopened.observations.read({ target: f.target, source: 'cache', topics: ['materials'] });
    expect(cached).toMatchObject({ ok: true, value: { values: { materials: { freshness: 'stale' } } } });
    f.request.mockClear();
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.request).not.toHaveBeenCalled();
    const moonrakerTarget = { printerId: id<'printer'>('moonraker'), routeId: id<'route'>('moonraker:moonraker') };
    await expect(f.moonraker.observations.watch({ target: moonrakerTarget, topics: ['status'] })[Symbol.asyncIterator]().next()).rejects.toThrow('Not implemented');
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.request).not.toHaveBeenCalled();
  } finally {
    firstAbort.abort(); secondAbort.abort();
    await first.return?.(); await second.return?.();
    vi.useRealTimers();
  }
});

it('shares queued configuration writes, generations and notifications across concrete agents', async () => {
  const f = fixture();
  const moonrakerTarget = { printerId: id<'printer'>('moonraker'), routeId: id<'route'>('moonraker:moonraker') };
  const before = await f.snapmaker.describe(f.target);
  if (!before.ok) throw new Error('Expected configured Snapmaker');
  const snapmaker = createSnapmakerService(f.options), moonraker = createMoonrakerService(f.options);
  const snapmakerChanged = vi.fn(), moonrakerChanged = vi.fn();
  const unsubscribeSnapmaker = snapmaker.onSavedChanged(snapmakerChanged);
  const unsubscribeMoonraker = moonraker.onSavedChanged(moonrakerChanged);
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const save = f.configuration.save;
  let first = true;
  f.configuration.save = async document => {
    if (first) { first = false; started(); await pending; }
    await save(document);
  };
  try {
    const snapmakerWrite = snapmaker.rename(f.target, 'Renamed U1');
    await entered;
    const moonrakerWrite = moonraker.rename(moonrakerTarget, 'Renamed Moonraker');
    const queuedRead = f.snapmaker.describe(f.target);
    expect(snapmakerChanged).not.toHaveBeenCalled();
    expect(moonrakerChanged).not.toHaveBeenCalled();
    release();
    expect((await Promise.all([snapmakerWrite, moonrakerWrite])).every(result => result.ok)).toBe(true);
    const after = await queuedRead;
    expect(after).toMatchObject({ ok: true, value: { configurationRevision: before.value.configurationRevision } });
    expect((await f.configuration.load()).printers.map(printer => printer.displayName)).toEqual(['Renamed Moonraker', 'Renamed U1']);
    expect(snapmakerChanged).toHaveBeenCalledTimes(2);
    expect(moonrakerChanged).toHaveBeenCalledTimes(2);
    expect(f.request).not.toHaveBeenCalled();
  } finally { release(); unsubscribeSnapmaker(); unsubscribeMoonraker(); }
});

it('isolates command request identities and operation lookup between concrete agents', async () => {
  const f = fixture();
  const moonrakerTarget = { printerId: id<'printer'>('moonraker'), routeId: id<'route'>('moonraker:moonraker') };
  const request = { requestId: id<'request'>('same-request'), command: { type: 'jobs.pause' as const, params: {} } };
  const [snapmaker, moonraker] = await Promise.all([
    f.snapmaker.controls.submit({ ...request, target: f.target }),
    f.moonraker.controls.submit({ ...request, target: moonrakerTarget }),
  ]);
  if (snapmaker.kind !== 'recorded' || moonraker.kind !== 'recorded') throw new Error('Expected both provider operations');
  expect(snapmaker.operation.id).not.toBe(moonraker.operation.id);
  const reopened = createSnapmakerService(f.options);
  expect(await reopened.controls.submit({ ...request, target: f.target })).toEqual(snapmaker);
  expect(await createMoonrakerService(f.options).controls.submit({ ...request, target: moonrakerTarget })).toEqual(moonraker);
  expect(await f.moonraker.operations.get(snapmaker.operation)).toMatchObject({ ok: true, value: { kind: 'unknown' } });
  expect(await reopened.operations.get(moonraker.operation)).toMatchObject({ ok: true, value: { kind: 'unknown' } });
  for await (const _operation of reopened.operations.watch(snapmaker.operation)) { /* drain */ }
  for await (const _operation of f.moonraker.operations.watch(moonraker.operation)) { /* drain */ }
  expect(f.request.mock.calls.filter(([request]) => request.method === 'POST')).toHaveLength(2);
});

it('shares prepared submissions across service facades and keeps upload-only free of job settings', async () => {
  const f = fixture();
  f.request.mockImplementation(async request => ({ status: 200, bytes: async () => { throw new Error('Unexpected binary read'); }, json: async () => request.url.endsWith('/objects/list')
    ? { result: { objects: ['gcode', 'print_task_config', 'extruder'] } }
      : request.url.includes('/objects/query?') ? { result: { status: { gcode: { commands: { SET_PRINT_EXTRUDER_MAP: {}, SET_PRINT_USED_EXTRUDERS: {}, SET_PRINT_PREFERENCES: {} } }, print_task_config: { filament_exist: [true], filament_type: ['PLA'] }, extruder: { nozzle_diameter: .4, nozzle_volume_type: 'standard' } } } }
        : request.body?.kind === 'multipart' ? { item: { root: 'gcodes', path: 'unchanged.gcode' } } : { result: 'ok' } }));
  const request: D.PrintPreparationRequest = { target: f.target, options: {}, suggest: true, bindings: [], allowAbnormalStorage: false,
    requirements: { contentId: 'receipt', plateId: 'plate', printerModel: 'Snapmaker U1', printerModelId: 'U1', materials: [{ key: 'filament-5', index: 5, toolIndex: 0, type: 'PLA', color: '#ff0000', brand: 'Generic', presetId: 'pla', presetName: 'PLA', nozzleDiameter: .4, nozzleFlowType: 'Standard', nozzleTemperature: 210, initialLayerNozzleTemperature: 215, chamberTemperature: 0, softeningTemperature: 55, requiredNozzleHardness: 0, usedGrams: 1, usedMeters: 1 }],
      nozzleDiameters: [.4, .4, .4, .4], nozzleFlowTypes: [], filamentMap: [1, 1, 1, 1, 1, 1], requiresDynamicMapping: false, bedType: 'plate', durationSeconds: 60, layerCount: 10, weightGrams: 1, timelapseWarningCode: 0, toolpathOutside: false, warnings: [] } };
  const prepared = await f.snapmaker.submissions.prepare(request);
  if (!prepared.ok) throw new Error(prepared.error.message);
  const submissionRequest = { ...request, bindings: prepared.value.bindings, jobName: 'Print', requestId: id<'request'>('submit'), acknowledgedIssues: prepared.value.issues.filter(i => i.severity === 'warning').map(i => i.id) };
  const sent = await f.snapmaker.submissions.submit(submissionRequest,
    [{ role: 'print', fileName: 'unchanged.gcode', sizeBytes: 3, chunks: (async function* () { yield new Uint8Array([255, 0, 10]); })() }]);
  if (!sent.ok) throw new Error(sent.error.message);
  const reopened = createSnapmakerService(f.options);
  expect(await reopened.submissions.submit(submissionRequest, [{ role: 'print', fileName: 'unchanged.gcode', sizeBytes: 3,
    chunks: (async function* () { throw new Error('Duplicate artifact must remain unread'); })() }])).toEqual(sent);
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
    return { status: 200, bytes: async () => { throw new Error('Unexpected binary read'); }, json: async () => request.url.endsWith('/objects/list') ? { result: { objects: ['gcode', 'print_task_config', 'filament_feed left', 'filament_feed right'] } }
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
    return { status: 200, bytes: async () => { throw new Error('Unexpected binary read'); }, json: async () => request.url.endsWith('/objects/list') ? { result: { objects: ['gcode', 'print_task_config'] } }
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
