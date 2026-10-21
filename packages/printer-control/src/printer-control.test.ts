import { describe, expect, it, vi } from 'vitest';
import { normalizePrinterConfigurationDocument, PrinterConfigurationValidationError } from './configuration';
import type { PrinterTransport, PrinterTransportRequest, PrinterTransportResponse } from './transport';
import { createMoonrakerService } from './service';
import type * as D from './domain';

const printer = {
  id: 'printer-a',
  displayName: 'Living room',
  driverId: 'moonraker' as const,
  consoleUrl: 'http://console.local:80/mainsail',
  apiBaseUrl: 'http://printer.local:7125/moonraker',
  apiKey: 'full-api-key-value',
};

class FixtureTransport implements PrinterTransport {
  readonly requests: PrinterTransportRequest[] = [];
  responses: unknown[] = [];
  statuses: number[] = [];
  handle?: (request: PrinterTransportRequest) => Promise<PrinterTransportResponse>;

  async request(request: PrinterTransportRequest): Promise<PrinterTransportResponse> {
    this.requests.push(request);
    if (this.handle) return this.handle(request);
    const body = this.responses.shift() ?? { result: {} };
    return { status: this.statuses.shift() ?? 200, json: async () => body };
  }
}

function documentWith(...records: typeof printer[]) {
  return normalizePrinterConfigurationDocument({ version: 1, printers: records });
}

describe('printer configuration', () => {
  it('normalizes version 1 URLs, preserves the complete key, and permits duplicate names', () => {
    const result = documentWith(printer, { ...printer, id: 'printer-b' });
    expect(result.version).toBe(1);
    expect(result.printers).toHaveLength(2);
    expect(result.printers[0]).toMatchObject({
      consoleUrl: 'http://console.local/mainsail',
      apiBaseUrl: 'http://printer.local:7125/moonraker',
      apiKey: 'full-api-key-value',
    });
    expect(result.printers.map(item => item.displayName)).toEqual(['Living room', 'Living room']);
  });

  it('accepts a blank console URL while keeping the API base URL required', () => {
    const result = documentWith({ ...printer, consoleUrl: '   ' });
    expect(result.printers[0].consoleUrl).toBe('');
    expect(() => documentWith({ ...printer, consoleUrl: '', apiBaseUrl: '' })).toThrow(PrinterConfigurationValidationError);
  });

  it('rejects unsupported URLs, credentials, duplicate IDs, and unsupported drivers', () => {
    expect(() => normalizePrinterConfigurationDocument({
      version: 1,
      printers: [
        printer,
        { ...printer, driverId: 'custom', id: 'printer-a', consoleUrl: 'ftp://host', apiBaseUrl: 'https://user:pass@host' },
      ],
    })).toThrow(PrinterConfigurationValidationError);
  });
});

const id = <K extends string>(value: string) => value as D.Id<K>;
const target: D.PrinterTarget = { printerId: id('printer-a'), routeId: id('moonraker:printer-a') };
const unwrap = <T>(result: D.Result<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value; };
function setup(record = printer) {
  let doc = documentWith(record);
  const configuration = { load: async () => doc, save: async (next: typeof doc) => { doc = next; } };
  const transport = new FixtureTransport();
  const options = { configuration, transport, host: { id: id<'agent-host'>('host'), name: 'Host', execution: 'browser' as const } };
  return { configuration, transport, service: createMoonrakerService(options), fresh: () => createMoonrakerService(options) };
}
function uploadRequest(overrides: Partial<D.UploadRequest> = {}): D.UploadRequest {
  return { target, requestId: id(crypto.randomUUID()), destination: { kind: 'default' }, fileName: 'cube.gcode', format: 'gcode', sizeBytes: 3, collisionPolicy: 'overwrite', ...overrides };
}
function source(): D.UploadSource { return { chunks: (async function* () { yield new Uint8Array([1, 2, 3]); })() }; }
async function finished(service: D.PrinterService, submission: D.Submission) {
  if (submission.kind !== 'recorded') throw new Error(JSON.stringify(submission));
  let latest: D.PrinterOperation | undefined;
  for await (const operation of service.operations.watch(submission.operation)) latest = operation;
  if (!latest) throw new Error('No operation');
  return latest;
}
async function uploaded(service: D.PrinterService) {
  const operation = await finished(service, await service.files.upload(uploadRequest(), source()));
  if (operation.kind !== 'upload' || operation.phase.kind !== 'completed') throw new Error(JSON.stringify(operation));
  return operation.phase.result;
}
function start(file: D.RemoteFile): D.CommandRequest {
  return { target, requestId: id(crypto.randomUUID()), command: { type: 'jobs.start', params: { source: { file: file.ref, consistency: 'best-effort' }, bindings: [] } } };
}

describe('Moonraker stateless service', () => {
  it('describes local capabilities and resolves the console without network I/O or credentials', async () => {
    const { service, transport } = setup();
    const saved = unwrap(await service.listSaved());
    const route = saved[0].routes[0];
    expect(route.capabilities.files.upload).toMatchObject({ kind: 'supported', constraints: [{ collisionPolicies: ['overwrite'] }] });
    expect(route.capabilities.observations.materials.kind).toBe('unsupported');
    expect(route.capabilities.files.list.kind).toBe('unsupported');
    expect(route.capabilities.cameras).toEqual([]);
    expect(route.capabilities.observations.job).toMatchObject({ constraints: { delivery: ['on-demand'] } });
    expect(unwrap(await service.describe(target)).descriptor.kind).toBe('unknown');
    expect(unwrap(await service.webInterfaces.resolve({ target })).url).toBe('http://console.local/mainsail');
    expect(JSON.stringify(saved)).not.toContain(printer.apiKey);
    expect(transport.requests).toEqual([]);
    const blank = setup({ ...printer, consoleUrl: '' });
    expect(unwrap(await blank.service.webInterfaces.resolve({ target })).url).toBe(printer.apiBaseUrl);
    expect(blank.transport.requests).toEqual([]);
  });

  it('uploads with explicit overwrite and starts the exact returned path without preflight calls', async () => {
    const { service, transport, fresh } = setup();
    transport.responses.push({ result: { item: { path: 'nested/remote.gcode' } } }, { result: 'ok' });
    const file = await uploaded(service);
    const started = await finished(fresh(), await fresh().controls.submit(start(file)));
    expect(started.phase).toEqual({ kind: 'acknowledged' });
    expect(started).not.toHaveProperty('phase.result.jobId');
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[0]).toMatchObject({ method: 'POST', url: `${printer.apiBaseUrl}/server/files/upload`, headers: { 'X-Api-Key': printer.apiKey }, body: { kind: 'multipart', fields: { root: 'gcodes' }, file: { fileName: 'cube.gcode', bytes: new Uint8Array([1, 2, 3]) } } });
    expect(transport.requests[1].body).toEqual({ kind: 'json', json: JSON.stringify({ filename: 'nested/remote.gcode' }) });
  });

  it('rejects unsupported collision policies before consuming the source', async () => {
    const { service, transport } = setup();
    const consume = vi.fn();
    const result = await service.files.upload(uploadRequest({ collisionPolicy: 'reject' }), { chunks: (async function* () { consume(); yield new Uint8Array(); })() });
    expect(result).toMatchObject({ kind: 'rejected', error: { code: 'unsupported' } });
    expect(consume).not.toHaveBeenCalled();
    expect(transport.requests).toEqual([]);
  });

  it('deduplicates same requests across fresh facades without consuming a duplicate source', async () => {
    const { service, transport, fresh } = setup();
    transport.responses.push({ result: { item: { path: 'cube.gcode' } } });
    const request = uploadRequest();
    const first = await service.files.upload(request, source());
    await finished(service, first);
    const consume = vi.fn();
    const { target: destination, ...parameters } = request;
    const second = await fresh().files.upload({ ...parameters, target: destination }, { chunks: (async function* () { consume(); yield new Uint8Array(); })() });
    expect(second).toEqual(first);
    expect(consume).not.toHaveBeenCalled();
    expect(transport.requests).toHaveLength(1);
    expect(await service.files.upload({ ...request, fileName: 'other.gcode' }, source())).toMatchObject({ kind: 'rejected', error: { code: 'invalid-request' } });
    expect(unwrap(await fresh().operations.find({ ...target, requestId: request.requestId })).kind).toBe('found');
  });

  it('checks declared byte size before dispatch', async () => {
    const { service, transport } = setup();
    for (const sizeBytes of [2, 4]) {
      const op = await finished(service, await service.files.upload(uploadRequest({ sizeBytes }), source()));
      expect(op.phase).toMatchObject({ kind: 'failed', error: { code: 'invalid-request' } });
    }
    expect(transport.requests).toEqual([]);
  });

  it('tracks unknown transport totals and cancels by operation reference on a fresh facade', async () => {
    const { service, transport, fresh } = setup();
    transport.handle = request => new Promise((_resolve, reject) => {
      request.onUploadProgress?.({ loaded: 2 });
      request.signal?.addEventListener('abort', () => reject(new Error('private headers')), { once: true });
    });
    const submission = await service.files.upload(uploadRequest(), source());
    if (submission.kind !== 'recorded') throw new Error('Not recorded');
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    const lookup = unwrap(await fresh().operations.get(submission.operation));
    expect(lookup).toMatchObject({ kind: 'found', operation: { progress: { sentBytes: 2, totalBytes: null, stage: 'transferring' } } });
    const observer = new AbortController();
    const watch = fresh().operations.watch(submission.operation, { signal: observer.signal })[Symbol.asyncIterator]();
    await watch.next(); observer.abort(); await watch.next();
    expect(transport.requests[0].signal?.aborted).toBe(false);
    await fresh().operations.requestUploadCancellation(submission.operation);
    expect(await finished(service, submission)).toMatchObject({ kind: 'upload', remoteFileMayExist: true, phase: { kind: 'cancelled' } });
  });

  it('cancels an upload whose source has stalled before sending any bytes', async () => {
    const { service, transport, fresh } = setup();
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const submission = await service.files.upload(uploadRequest(), { chunks: {
      [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<Uint8Array>>(() => {}), return: returned }; },
    } });
    if (submission.kind !== 'recorded') throw new Error('Not recorded');
    await fresh().operations.requestUploadCancellation(submission.operation);
    expect(await finished(service, submission)).toMatchObject({ phase: { kind: 'cancelled' }, remoteFileMayExist: false });
    expect(transport.requests).toEqual([]);
    expect(returned).toHaveBeenCalledOnce();
  });

  it('persists manual changes locally, deduplicates add, and rejects stale configuration edits', async () => {
    const { service, fresh, transport } = setup();
    const original = unwrap(await service.listSaved())[0].routes[0];
    const request = { requestId: id<'request'>('add'), displayName: ' New ', routes: [{ ...original.configuration, credentialRef: null }] as const };
    const added = unwrap(await service.add(request));
    expect(added.identity.displayName).toBe('New');
    expect(unwrap(await fresh().add(request)).identity.id).toBe(added.identity.id);
    expect(unwrap(await service.listSaved())).toHaveLength(2);
    expect(await service.add({ ...request, displayName: 'Changed' })).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
    const route = unwrap(await service.updateRoute({ target, configuration: { ...original.configuration, address: 'http://new.local/' } }));
    expect(route.configurationRevision).not.toBe(original.configurationRevision);
    expect(await service.updateRoute({ target: { ...target, expectedConfigurationRevision: original.configurationRevision }, configuration: original.configuration })).toMatchObject({ ok: false, error: { code: 'stale-context' } });
    expect(unwrap(await service.rename(added.identity.id, ' Renamed ')).identity.displayName).toBe('Renamed');
    await service.forget(added.identity.id);
    expect(unwrap(await service.listSaved())).toHaveLength(1);
    expect(transport.requests).toEqual([]);
  });

  it('invalidates refs and cached observations on configuration edits while preserving in-flight routing', async () => {
    const { service, configuration, transport } = setup();
    let complete!: (response: PrinterTransportResponse) => void;
    transport.handle = () => new Promise(resolve => { complete = resolve; });
    const submission = await service.files.upload(uploadRequest(), source());
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    await configuration.save(documentWith({ ...printer, apiBaseUrl: 'http://replacement.local/' }));
    const next = unwrap(await service.describe(target));
    complete({ status: 200, json: async () => ({ result: { item: { path: 'cube.gcode' } } }) });
    const op = await finished(service, submission);
    if (op.kind !== 'upload' || op.phase.kind !== 'completed') throw new Error('Upload failed');
    expect(op.configurationRevision).not.toBe(next.configurationRevision);
    expect(transport.requests[0].url).toContain('printer.local:7125');
    expect(await service.controls.submit(start(op.phase.result))).toMatchObject({ kind: 'rejected', error: { code: 'stale-context' } });
    expect(transport.requests).toHaveLength(1);
  });

  it('reads metadata/status only on demand and exposes verified native job identity for controls', async () => {
    const { service, transport } = setup({ ...printer, apiKey: '' });
    const status = { result: { status: { print_stats: { state: 'printing', filename: 'cube.gcode' }, virtual_sdcard: { progress: 0.25 } } } };
    const history = { result: { jobs: [{ job_id: '000042', filename: 'cube.gcode', status: 'in_progress', end_time: null }] } };
    transport.responses.push({ result: { moonraker_version: '0.9' } }, status, history);
    expect(unwrap(await service.observations.read({ target, topics: ['job'], source: 'cache' })).values.job.kind).toBe('unknown');
    expect(transport.requests).toEqual([]);
    const metadata = unwrap(await service.observations.read({ target, topics: ['firmware'], source: 'device' }));
    expect(metadata.values.firmware).toMatchObject({ kind: 'known', value: [{ name: 'Moonraker', version: '0.9' }] });
    const snapshot = unwrap(await service.observations.read({ target, topics: ['job'], source: 'device' }));
    if (snapshot.values.job.kind !== 'known' || snapshot.values.job.value.job.kind !== 'known' || !snapshot.values.job.value.job.value) throw new Error('Missing job');
    const jobId = snapshot.values.job.value.job.value.id;
    for (const [type, script] of [['jobs.pause', 'PAUSE'], ['jobs.resume', 'RESUME'], ['jobs.cancel', 'CANCEL_PRINT']] as const) {
      transport.responses.push(status, history, { result: 'ok' });
      const op = await finished(service, await service.controls.submit({ target, requestId: id(crypto.randomUUID()), command: { type, params: { jobId } } } as D.CommandRequest));
      expect(op.phase.kind).toBe('acknowledged');
      expect(transport.requests.at(-1)?.body).toEqual({ kind: 'json', json: JSON.stringify({ script }) });
    }
    expect(transport.requests.every(request => !request.headers?.['X-Api-Key'])).toBe(true);
    const before = transport.requests.length;
    const cache = unwrap(await service.observations.read({ target, topics: ['job'], source: 'cache' }));
    expect(cache.values.job).toMatchObject({ freshness: 'stale', value: { operationalState: { freshness: 'stale' }, job: { freshness: 'stale' } } });
    expect(transport.requests).toHaveLength(before);
    transport.responses.push(status, { result: { jobs: [{ job_id: '000043', filename: 'cube.gcode', status: 'in_progress', end_time: null }] } });
    expect(await service.controls.submit({ target, requestId: id('stale-job'), command: { type: 'jobs.cancel', params: { jobId } } })).toMatchObject({ kind: 'rejected', error: { code: 'precondition-failed' } });
    expect(transport.requests.at(-1)?.method).toBe('GET');
  });

  it('does not fabricate job IDs when history is absent', async () => {
    const { service, transport } = setup();
    transport.responses.push({ result: { status: { print_stats: { state: 'printing', filename: 'cube.gcode' } } } }, { error: { message: 'No history' } });
    const snapshot = unwrap(await service.observations.read({ target, topics: ['job'], source: 'device' }));
    expect(snapshot.values.job).toMatchObject({ kind: 'known', value: { operationalState: { value: 'busy' }, job: { kind: 'unknown' } } });
  });

  it.each([{}, { result: {} }, { result: 'unexpected' }])('does not acknowledge malformed command confirmation %j', async response => {
    const { service, transport } = setup();
    transport.responses.push({ result: { item: { path: 'cube.gcode' } } }, response);
    const file = await uploaded(service);
    expect((await finished(service, await service.controls.submit(start(file)))).phase.kind).toBe('outcome-unknown');
  });

  it('sanitizes failed responses and preserves uncertain POST outcomes without resending', async () => {
    const { service, transport } = setup();
    transport.responses.push({ result: { item: { path: 'cube.gcode' } } });
    const file = await uploaded(service);
    transport.statuses.push(401);
    const rejected = await finished(service, await service.controls.submit(start(file)));
    expect(rejected.phase).toMatchObject({ kind: 'failed', error: { code: 'authentication-required' } });
    transport.handle = async () => { throw new Error(`secret: ${printer.apiKey}`); };
    const request = start(file);
    const submission = await service.controls.submit(request);
    const uncertain = await finished(service, submission);
    expect(uncertain.phase.kind).toBe('outcome-unknown');
    expect(JSON.stringify(uncertain)).not.toContain(printer.apiKey);
    expect(await service.controls.submit(request)).toEqual(submission);
    expect(transport.requests).toHaveLength(3);
  });
});
