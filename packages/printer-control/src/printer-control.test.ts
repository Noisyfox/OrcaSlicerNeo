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
    return { status: this.statuses.shift() ?? (request.url.endsWith('/server/files/upload') ? 201 : 200), json: async () => body };
  }
}

// Moonraker's HTTP upload response has no result envelope, including on overwrite.
function uploadResponse(path: string) {
  return { item: { root: 'gcodes', path }, action: 'create_file', print_started: false, print_queued: false };
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
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
    transport.responses.push(uploadResponse('nested/remote.gcode'), { result: 'ok' });
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

  it('completes upload-only and repeated same-name overwrite from HTTP 201 receipts', async () => {
    const { service, transport } = setup();
    transport.responses.push(uploadResponse('cube.gcode'), uploadResponse('cube.gcode'));
    const first = await uploaded(service);
    const overwritten = await uploaded(service);
    expect(overwritten.ref).toEqual(first.ref);
    expect(first.ref).toMatchObject({ ...target, storageId: 'gcodes', fileId: 'moonraker-file:cube.gcode' });
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests.every(request => request.url.endsWith('/server/files/upload'))).toBe(true);
  });

  it.each<[string, unknown]>([
    ['missing item', {}],
    ['incorrect result envelope', { result: uploadResponse('cube.gcode') }],
    ['alternate filename field', { item: { root: 'gcodes', filename: 'cube.gcode' } }],
    ['missing root', { item: { path: 'cube.gcode' } }],
    ['wrong root', { item: { root: 'config', path: 'cube.gcode' } }],
    ...['', '/cube.gcode', '../cube.gcode', 'nested/../cube.gcode', 'nested/', 'bad\u0000.gcode'].map((path): [string, unknown] => ['invalid path', uploadResponse(path)]),
  ])('keeps malformed upload receipts outcome-unknown without retry: %s', async (_label, response) => {
    const { service, transport } = setup();
    transport.responses.push(response);
    const request = uploadRequest();
    const submission = await service.files.upload(request, source());
    expect(await finished(service, submission)).toMatchObject({ kind: 'upload', remoteFileMayExist: true, phase: { kind: 'outcome-unknown' } });
    expect(await service.files.upload(request, source())).toEqual(submission);
    expect(transport.requests).toHaveLength(1);
  });

  it('keeps an interrupted upload response outcome-unknown without resending', async () => {
    const { service, transport } = setup();
    transport.handle = async () => ({ status: 201, json: async () => { throw new Error('response interrupted'); } });
    const submission = await service.files.upload(uploadRequest(), source());
    expect(await finished(service, submission)).toMatchObject({ remoteFileMayExist: true, phase: { kind: 'outcome-unknown' } });
    expect(transport.requests).toHaveLength(1);
  });

  it('deduplicates same requests across fresh facades without consuming a duplicate source', async () => {
    const { service, transport, fresh } = setup();
    transport.responses.push(uploadResponse('cube.gcode'));
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
    complete({ status: 201, json: async () => uploadResponse('cube.gcode') });
    const op = await finished(service, submission);
    if (op.kind !== 'upload' || op.phase.kind !== 'completed') throw new Error('Upload failed');
    expect(op.configurationRevision).not.toBe(next.configurationRevision);
    expect(transport.requests[0].url).toContain('printer.local:7125');
    expect(await service.controls.submit(start(op.phase.result))).toMatchObject({ kind: 'rejected', error: { code: 'stale-context' } });
    expect(transport.requests).toHaveLength(1);
  });

  it.each([false, true])('pins concurrent upload routing, credentials and file provenance, with revision check=%s', async checked => {
    const { service, fresh, configuration, transport } = setup();
    const original = unwrap(await service.listSaved())[0].routes[0];
    const replacement = { ...printer, apiBaseUrl: 'http://replacement.local/', apiKey: 'replacement-key' };
    vi.spyOn(configuration, 'load').mockResolvedValueOnce(documentWith(printer)).mockResolvedValue(documentWith(replacement));
    transport.responses.push(uploadResponse('cube.gcode'));

    // Both facades read different configurations before either caller uses its result.
    const [submission, listing] = await Promise.all([
      service.files.upload(uploadRequest({ target: checked ? { ...target, expectedConfigurationRevision: original.configurationRevision } : target }), source()),
      fresh().listSaved(),
    ]);
    const current = unwrap(listing)[0].routes[0];
    const operation = await finished(service, submission);
    if (operation.kind !== 'upload' || operation.phase.kind !== 'completed') throw new Error('Upload failed');
    expect(operation.configurationRevision).toBe(original.configurationRevision);
    expect(operation.phase.result.ref.configurationRevision).toBe(original.configurationRevision);
    expect(current.configuration.address).toBe(replacement.apiBaseUrl);
    expect(current.configurationRevision).not.toBe(original.configurationRevision);
    expect(transport.requests[0]).toMatchObject({ url: `${printer.apiBaseUrl}/server/files/upload`, headers: { 'X-Api-Key': printer.apiKey } });
    expect(await fresh().controls.submit(start(operation.phase.result))).toMatchObject({ kind: 'rejected', error: { code: 'stale-context' } });
    expect(transport.requests).toHaveLength(1);
  });

  it('keeps concurrent saved-printer projections paired with their own configuration revisions', async () => {
    const { service, fresh, configuration, transport } = setup();
    const original = unwrap(await service.listSaved())[0].routes[0];
    const replacement = { ...printer, consoleUrl: 'http://replacement.local/console' };
    vi.spyOn(configuration, 'load').mockResolvedValueOnce(documentWith(printer)).mockResolvedValue(documentWith(replacement));
    const [first, second] = await Promise.all([service.listSaved(), fresh().listSaved()]);
    expect(unwrap(first)[0].routes[0]).toEqual(original);
    const current = unwrap(second)[0].routes[0];
    expect(current.configuration.webInterfaceUrl).toBe(replacement.consoleUrl);
    expect(current.configurationRevision).not.toBe(original.configurationRevision);
    expect(unwrap(await service.webInterfaces.resolve({ target: { ...target, expectedConfigurationRevision: current.configurationRevision } })).url).toBe(replacement.consoleUrl);
    expect(transport.requests).toEqual([]);
  });

  it('orders repository reads across facades so a delayed old read cannot overwrite a newer generation', async () => {
    const { service, fresh, configuration } = setup();
    const original = unwrap(await service.listSaved())[0].routes[0];
    const entered = deferred<void>();
    const oldRead = deferred<ReturnType<typeof documentWith>>();
    const load = vi.spyOn(configuration, 'load')
      .mockImplementationOnce(() => { entered.resolve(); return oldRead.promise; })
      .mockResolvedValue(documentWith({ ...printer, apiBaseUrl: 'http://replacement.local/' }));
    const first = service.listSaved();
    await entered.promise;
    const second = fresh().listSaved();
    expect(load).toHaveBeenCalledTimes(1);
    oldRead.resolve(documentWith(printer));
    const [older, newer] = await Promise.all([first, second]);
    expect(unwrap(older)[0].routes[0]).toEqual(original);
    const current = unwrap(newer)[0].routes[0];
    expect(current.configurationRevision).not.toBe(original.configurationRevision);
    expect(unwrap(await service.listSaved())[0].routes[0]).toEqual(current);
  });

  it('queues reads and guarded edits behind a pending save, returning the saved generation', async () => {
    const { service, fresh, configuration, transport } = setup();
    const original = unwrap(await service.listSaved())[0].routes[0];
    const entered = deferred<void>(), release = deferred<void>();
    const persist = configuration.save;
    vi.spyOn(configuration, 'save').mockImplementationOnce(async doc => { entered.resolve(); await release.promise; await persist(doc); });
    const load = vi.spyOn(configuration, 'load');
    const edit = service.updateRoute({ target, configuration: { ...original.configuration, address: 'http://replacement.local/' } });
    await entered.promise;
    const listing = fresh().listSaved();
    const staleEdit = fresh().updateRoute({ target: { ...target, expectedConfigurationRevision: original.configurationRevision }, configuration: original.configuration });
    expect(load).toHaveBeenCalledTimes(1);
    release.resolve();
    const [edited, listed, rejected] = await Promise.all([edit, listing, staleEdit]);
    const current = unwrap(edited);
    expect(current.configuration.address).toBe('http://replacement.local/');
    expect(current.configurationRevision).not.toBe(original.configurationRevision);
    expect(unwrap(listed)[0].routes[0]).toEqual(current);
    expect(rejected).toMatchObject({ ok: false, error: { code: 'stale-context' } });
    expect(transport.requests).toEqual([]);
  });

  it.each(['replace', 'forget-and-readd'] as const)('keeps late device observations out of the current cache after %s', async change => {
    const { service, fresh, configuration, transport } = setup();
    const original = unwrap(await service.listSaved())[0].routes[0];
    const entered = deferred<void>(), oldResponse = deferred<PrinterTransportResponse>();
    transport.handle = async () => { entered.resolve(); return oldResponse.promise; };
    const pending = service.observations.read({ target, topics: ['descriptor', 'firmware'], source: 'device' });
    await entered.promise;
    if (change === 'forget-and-readd') await fresh().forget(target.printerId);
    await configuration.save(documentWith({ ...printer, apiBaseUrl: 'http://replacement.local/', apiKey: 'replacement-key' }));
    const current = unwrap(await fresh().listSaved())[0].routes[0];
    transport.handle = async () => ({ status: 200, json: async () => ({ result: { moonraker_version: 'new-device' } }) });
    await fresh().observations.read({ target, topics: ['descriptor', 'firmware'], source: 'device' });
    oldResponse.resolve({ status: 200, json: async () => ({ result: { moonraker_version: 'old-device' } }) });
    const older = unwrap(await pending);
    expect(older.configurationRevision).toBe(original.configurationRevision);
    expect(older.values.firmware).toMatchObject({ value: [{ version: 'old-device' }] });
    const cached = unwrap(await fresh().observations.read({ target, topics: ['descriptor', 'firmware'], source: 'cache' }));
    expect(cached.configurationRevision).toBe(current.configurationRevision);
    expect(current.configurationRevision).not.toBe(original.configurationRevision);
    expect(cached.values.firmware).toMatchObject({ value: [{ version: 'new-device' }] });
    expect(cached.values.descriptor).toMatchObject({ value: { firmware: { value: [{ version: 'new-device' }] } } });
    expect(transport.requests.map(request => [request.url, request.headers?.['X-Api-Key']])).toEqual([
      [`${printer.apiBaseUrl}/server/info`, printer.apiKey], ['http://replacement.local/server/info', 'replacement-key'],
    ]);
  });

  it('recovers the shared configuration queue after load and save failures without publishing an unsaved revision', async () => {
    const { service, fresh, configuration } = setup();
    const original = unwrap(await service.listSaved())[0].routes[0];
    vi.spyOn(configuration, 'load').mockRejectedValueOnce(new Error('load failed'));
    const [failed, recovered] = await Promise.all([service.listSaved(), fresh().listSaved()]);
    expect(failed.ok).toBe(false);
    expect(unwrap(recovered)[0].routes[0]).toEqual(original);
    vi.spyOn(configuration, 'save').mockRejectedValueOnce(new Error('save failed'));
    const [edit, renamed] = await Promise.all([
      service.updateRoute({ target, configuration: { ...original.configuration, address: 'http://unsaved.local/' } }),
      fresh().rename(target.printerId, 'Renamed'),
    ]);
    expect(edit.ok).toBe(false);
    expect(unwrap(renamed).identity.displayName).toBe('Renamed');
    expect(unwrap(renamed).routes[0]).toEqual(original);
    expect(unwrap(await service.listSaved())[0]).toEqual(unwrap(renamed));
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
    transport.responses.push(uploadResponse('cube.gcode'), response);
    const file = await uploaded(service);
    expect((await finished(service, await service.controls.submit(start(file)))).phase.kind).toBe('outcome-unknown');
  });

  it('sanitizes failed responses and preserves uncertain POST outcomes without resending', async () => {
    const { service, transport } = setup();
    transport.responses.push(uploadResponse('cube.gcode'));
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
