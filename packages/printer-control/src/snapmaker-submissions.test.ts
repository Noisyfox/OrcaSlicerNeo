import { expect, it, vi } from 'vitest';
import type * as D from './domain';
import { MoonrakerHttp } from './moonraker-http';
import { U1Submissions, U1_SEND_FAILURE } from './snapmaker-submissions';
import type { PrinterTransportRequest } from './transport';
import { normalizePrinterConfigurationDocument } from './configuration';

const id = <K extends string>(value: string) => value as D.Id<K>;
const target = { printerId: id<'printer'>('u1'), routeId: id<'route'>('snapmaker:u1') };
const bytes = new Uint8Array([255, 0, 84, 51, 49, 10]); // Deliberately opaque to the sender.
function fixture() {
  const request: D.PrintSubmissionRequest = { target, requestId: id('request'), jobName: 'Print', options: {}, acknowledgedIssues: [], allowAbnormalStorage: false,
    bindings: [{ materialKey: 'filament-5', pathId: id('snapmaker-path:2') }], requirements: { contentId: 'receipt', plateId: 'plate', printerModel: 'Snapmaker U1', printerModelId: 'U1',
      materials: [{ key: 'filament-5', index: 5, toolIndex: 2, type: 'PLA', color: '#ff0000', brand: 'Generic', presetId: 'pla', presetName: 'PLA', nozzleDiameter: .4, nozzleFlowType: 'Standard',
        nozzleTemperature: 210, initialLayerNozzleTemperature: 215, chamberTemperature: 0, softeningTemperature: 55, requiredNozzleHardness: 0, usedGrams: 1, usedMeters: 1 }],
      nozzleDiameters: [.4, .4, .4, .4], nozzleFlowTypes: [], filamentMap: [1, 1, 1, 1, 1, 3], requiresDynamicMapping: false, bedType: 'plate', durationSeconds: 60, layerCount: 10,
      weightGrams: 1, timelapseWarningCode: 0, toolpathOutside: false, warnings: [] } };
  const artifact = (): D.PrintArtifactSource => ({ role: 'print', fileName: 'print.gcode', sizeBytes: bytes.length, chunks: (async function* () { yield bytes; })() });
  const printer = normalizePrinterConfigurationDocument({ version: 1, printers: [{ id: 'u1', driverId: 'snapmaker', displayName: 'U1', apiBaseUrl: 'http://printer', apiKey: '', consoleUrl: '' }] }).printers[0];
  const transport = vi.fn(async (request: PrinterTransportRequest) => ({ status: 200, json: async () => request.body?.kind === 'multipart'
    ? { item: { root: 'gcodes', path: 'print.gcode' } } : { result: 'ok' } }));
  const prepare = vi.fn(async (input: D.PrintPreparationRequest): Promise<D.Result<D.PrintPreparation>> => ({ ok: true, value: { configurationRevision: 'r1', route: 'lan',
    nozzleLabels: [], bindings: input.bindings, candidates: [], materialCatalogIds: [], options: { bedLeveling: 'on', flowCalibration: 'on', timelapse: false }, optionDescriptors: [], issues: [] } }));
  const resolve = vi.fn(async () => ({ printer, revision: 'r1' }));
  const service = new U1Submissions({ http: new MoonrakerHttp({ request: transport }), resolve, prepare });
  const submit = async (input = request, source = artifact()) => {
    const result = await service.submit(input, [source]);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  const done = async (ref: D.PrintSubmissionRef) => {
    let last: D.PrintSubmissionState | undefined;
    for await (const value of service.watch(ref)) last = value;
    return last!;
  };
  return { service, request, transport, prepare, resolve, artifact, submit, done };
}
const script = (request: PrinterTransportRequest) => request.body?.kind === 'json' ? JSON.parse(request.body.json).script as string | undefined : undefined;

it('uploads identical bytes, then applies mapping/options, then starts without settings readback', async () => {
  const f = fixture(), ref = await f.submit();
  expect((await f.done(ref)).phase).toBe('sent');
  const calls = f.transport.mock.calls.map(([request]) => request);
  expect(calls.map(c => new URL(c.url).pathname)).toEqual(['/server/files/upload', '/printer/gcode/script', '/printer/gcode/script', '/printer/gcode/script', '/printer/print/start']);
  expect(calls[0].body).toMatchObject({ kind: 'multipart', file: { bytes } });
  expect(calls.slice(1, 4).map(script)).toEqual(['SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=5 MAP_EXTRUDER=2', 'SET_PRINT_USED_EXTRUDERS EXTRUDERS=2',
    'SET_PRINT_PREFERENCES BED_LEVEL=1 FLOW_CALIBRATE=1 TIME_LAPSE_CAMERA=0 FLOW_CALIBRATE_EXTRUDERS=2']);
  expect(f.prepare).toHaveBeenCalledTimes(2);
});
it.each(['upload', 'preparation', 'start'])('stops at %s failure and uses generic manual-retry presentation', async stage => {
  const f = fixture();
  const normal = f.transport.getMockImplementation()!;
  f.transport.mockImplementation(async request => {
    if (stage === 'upload' && request.body?.kind === 'multipart' || stage === 'preparation' && script(request)?.startsWith('SET_PRINT_USED') || stage === 'start' && request.url.endsWith('/print/start')) throw new Error('lost response');
    return normal(request);
  });
  const state = await f.done(await f.submit());
  expect(state).toMatchObject({ phase: 'failed', message: U1_SEND_FAILURE, canCancel: false });
  if (stage !== 'start') expect(f.transport.mock.calls.some(([r]) => r.url.endsWith('/print/start'))).toBe(false);
  if (stage === 'upload') expect(f.transport.mock.calls.some(([r]) => script(r))).toBe(false);
  expect(f.transport.mock.calls.every(([r]) => !r.url.includes('delete'))).toBe(true);
  f.transport.mockImplementation(normal);
  expect((await f.done(await f.submit({ ...f.request, requestId: id('manual-retry') }))).phase).toBe('sent');
  expect(f.transport.mock.calls.filter(([r]) => r.body?.kind === 'multipart')).toHaveLength(2);
});
it('stops after an explicit preparation rejection without rollback or start', async () => {
  const f = fixture(), normal = f.transport.getMockImplementation()!;
  f.transport.mockImplementation(async request => script(request)?.startsWith('SET_PRINT_USED') ? { status: 400, json: async () => ({ result: 'ok' }) } : normal(request));
  expect((await f.done(await f.submit())).phase).toBe('failed');
  expect(f.transport.mock.calls).toHaveLength(3);
});
it('cancels an upload and never dispatches preparation or physical print stop', async () => {
  const f = fixture();
  f.transport.mockImplementation(async request => { await new Promise((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(new Error('abort')), { once: true })); throw new Error('unreachable'); });
  const ref = await f.submit(); await vi.waitFor(() => expect(f.transport).toHaveBeenCalledOnce());
  await f.service.cancel(ref);
  expect((await f.done(ref)).phase).toBe('cancelled'); expect(f.transport).toHaveBeenCalledOnce();
});
it('checks cancellation after an in-flight preparation acknowledgement before the next command', async () => {
  const f = fixture(), normal = f.transport.getMockImplementation()!;
  let release!: () => void;
  f.transport.mockImplementation(async request => { if (script(request)?.startsWith('SET_PRINT_EXTRUDER')) await new Promise<void>(resolve => { release = resolve; }); return normal(request); });
  const ref = await f.submit(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await f.service.cancel(ref); release();
  expect((await f.done(ref)).phase).toBe('cancelled'); expect(f.transport.mock.calls).toHaveLength(2);
});
it('cannot recall an already dispatched start and never reports it as cancelled', async () => {
  const f = fixture(), normal = f.transport.getMockImplementation()!;
  let release!: () => void;
  f.transport.mockImplementation(async request => { if (request.url.endsWith('/print/start')) await new Promise<void>(resolve => { release = resolve; }); return normal(request); });
  const ref = await f.submit(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect(await f.service.cancel(ref)).toMatchObject({ ok: true, value: { phase: 'sending', canCancel: false } });
  release(); expect((await f.done(ref)).phase).toBe('sent'); expect(f.transport.mock.calls).toHaveLength(5);
});
it('deduplicates concurrent admission and keeps operations alive after an observer leaves', async () => {
  const f = fixture();
  const [one, two] = await Promise.all([f.submit(), f.submit()]); expect(one).toEqual(two);
  const abort = new AbortController(), watch = f.service.watch(one, { signal: abort.signal })[Symbol.asyncIterator]();
  await watch.next(); abort.abort(); await watch.return?.();
  expect((await f.done(one)).phase).toBe('sent'); expect(f.transport).toHaveBeenCalledTimes(5);
  expect(await f.service.get({ ...one, printerId: id('other') })).toMatchObject({ ok: false });
  expect(await f.service.submit({ ...f.request, jobName: 'changed' }, [f.artifact()])).toMatchObject({ ok: false });
});
it('blocks stale target configuration and changed warning acknowledgement after upload', async () => {
  const f = fixture();
  f.prepare.mockImplementationOnce(async request => ({ ok: true, value: { configurationRevision: 'r1', route: 'lan', bindings: request.bindings, nozzleLabels: [], candidates: [], options: {}, optionDescriptors: [], materialCatalogIds: [], issues: [] } }));
  f.prepare.mockResolvedValue({ ok: false, error: { code: 'stale-context', message: 'Changed material' } });
  expect((await f.done(await f.submit())).phase).toBe('failed'); expect(f.transport).toHaveBeenCalledOnce();
  const other = fixture(); other.resolve.mockImplementationOnce(async () => ({ printer: normalizePrinterConfigurationDocument({ version: 1, printers: [{ id: 'u1', driverId: 'snapmaker', displayName: 'U1', apiBaseUrl: 'http://printer', apiKey: '', consoleUrl: '' }] }).printers[0], revision: 'r1' }));
  other.resolve.mockRejectedValue(new Error('Changed configuration'));
  expect((await other.done(await other.submit())).phase).toBe('failed'); expect(other.transport).not.toHaveBeenCalled();
});
it('cancels a stalled artifact producer and rejects size mismatches before upload', async () => {
  const f = fixture();
  const ref = await f.submit(f.request, { ...f.artifact(), chunks: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) } });
  await f.service.cancel(ref); expect((await f.done(ref)).phase).toBe('cancelled'); expect(f.transport).not.toHaveBeenCalled();
  const bad = await f.submit({ ...f.request, requestId: id('bad') }, { ...f.artifact(), sizeBytes: 1 });
  expect((await f.done(bad)).phase).toBe('failed'); expect(f.transport).not.toHaveBeenCalled();
});

it('rejects a second local transaction instead of interleaving its mapping or creating a queue', async () => {
  const f = fixture();
  f.transport.mockImplementation(async request => { await new Promise((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(new Error('abort')), { once: true })); throw new Error('unreachable'); });
  const ref = await f.submit(); await vi.waitFor(() => expect(f.transport).toHaveBeenCalledOnce());
  expect(await f.service.submit({ ...f.request, requestId: id('second') }, [f.artifact()])).toMatchObject({ ok: false, error: { code: 'busy' } });
  await f.service.cancel(ref); await f.done(ref); expect(f.transport).toHaveBeenCalledOnce();
});
