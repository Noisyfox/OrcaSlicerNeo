import { unsupportedSubmissions } from './submission';
/** Moonraker migration: request-only domain service over the existing host HTTP/configuration seams. */
import { normalizePrinterConfigurationDocument, type PrinterConfiguration, type PrinterConfigurationDocument } from './configuration';
import type { PrinterTransport } from './transport';
import type * as D from './domain';
import { MoonrakerHttp, MoonrakerFailure, fail, publicError, record } from './moonraker-http';
import { OperationStore, copy, newId, requestSignature, streamError } from './operations';

export interface MoonrakerServiceOptions {
  configuration: { onChanged?(listener: () => void): () => void; load(): Promise<PrinterConfigurationDocument>; save(document: PrinterConfigurationDocument): Promise<void> };
  transport: PrinterTransport;
  host: D.AgentHost;
}
const providerId = 'moonraker' as D.Id<'provider'>;
const typeId = 'moonraker' as D.Id<'printer-type'>;
const storageId = 'gcodes' as D.Id<'storage'>;
const webId = 'moonraker-web' as D.Id<'web-interface'>;
const unsupported = { kind: 'unsupported', layer: 'adapter', reason: 'Not implemented by the Moonraker adapter' } as const;
const unknown = { kind: 'unknown', reason: 'not-reported' } as const;
const rejected = (): D.Result<never> => ({ ok: false, error: { code: 'unsupported', message: unsupported.reason } });
const unsupportedStream = async function* (): AsyncIterable<never> { throw streamError(unsupported.reason); };
const supported = <C extends object>(constraints: C): D.Capability<C> => ({ kind: 'supported', constraints });
const routeId = (id: string) => `moonraker:${id}` as D.Id<'route'>;
const targetFor = (id: string): D.PrinterTarget => ({ printerId: id as D.Id<'printer'>, routeId: routeId(id) });
const known = <T>(target: D.PrinterTarget, value: T): D.Reading<T> => ({ kind: 'known', value, freshness: 'fresh', sourceRouteId: target.routeId, observedAtMs: null, receivedAtMs: Date.now() });
/** Cached projections retain original timestamps and mark nested readings stale too. */
function retained<T>(value: T): T {
  const snapshot = copy(value);
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const fields = record(node);
    if (fields.kind === 'known' && fields.freshness === 'fresh') fields.freshness = 'stale';
    for (const child of Object.values(node)) visit(child);
  };
  visit(snapshot);
  return snapshot;
}
const safe = async <T>(work: () => T | Promise<T>): Promise<D.Result<T>> => {
  try { return { ok: true, value: await work() }; } catch (error) { return { ok: false, error: publicError(error) }; }
};
interface ConfigurationEntry {
  readonly signature: string;
  readonly revision: D.Revision;
  readonly cache: Partial<{ [K in D.StateTopic]: D.Reading<D.PrinterObservationMap[K]> }>;
}
interface ResolvedConfiguration {
  readonly printer: Readonly<PrinterConfiguration>;
  readonly entry: ConfigurationEntry;
}
interface ConfigurationSnapshot {
  readonly document: PrinterConfigurationDocument;
  readonly printers: readonly ResolvedConfiguration[];
}
/** Shared by fresh service facades on the same host repository; never a caller session. */
const authorities = new WeakMap<object, { configurations: Map<string, ConfigurationEntry>; operations: OperationStore; additions: Map<string, { signature: string; printerId: string }>; configurationQueue: Promise<void>; listeners: Set<() => void> }>();

export function createMoonrakerService(options: MoonrakerServiceOptions): D.PrinterService {
  let authority = authorities.get(options.configuration);
  if (!authority) {
    authority = { configurations: new Map(), operations: new OperationStore(), additions: new Map(), configurationQueue: Promise.resolve(), listeners: new Set() };
    authorities.set(options.configuration, authority);
  }
  const state = authority;
  const http = new MoonrakerHttp(options.transport);
  const operations = state.operations;
  /** Only local repository work is queued; printer I/O retains its resolved snapshot. */
  function withConfiguration<T>(work: () => T | Promise<T>): Promise<T> {
    const next = state.configurationQueue.then(work);
    state.configurationQueue = next.then(() => undefined, () => undefined);
    return next;
  }
  /** Called within the configuration queue, with a normalized, owned document. */
  function bindConfiguration(doc: PrinterConfigurationDocument): ConfigurationSnapshot {
    for (const id of state.configurations.keys()) if (!doc.printers.some(p => p.id === id)) state.configurations.delete(id);
    const printers = doc.printers.map(printer => {
      const signature = JSON.stringify([printer.driverId, printer.apiBaseUrl, printer.consoleUrl, printer.apiKey]);
      let entry = state.configurations.get(printer.id);
      if (entry?.signature !== signature) {
        entry = { signature, revision: newId<'configuration'>(), cache: {} };
        state.configurations.set(printer.id, entry);
      }
      // Retain this generation even if another request replaces the map entry.
      return { printer: Object.freeze(printer), entry };
    });
    return { document: doc, printers };
  }
  async function loadConfiguration(): Promise<ConfigurationSnapshot> {
    return bindConfiguration(normalizePrinterConfigurationDocument(await options.configuration.load()));
  }
  async function saveConfiguration(doc: PrinterConfigurationDocument): Promise<ConfigurationSnapshot> {
    const normalized = normalizePrinterConfigurationDocument(doc);
    await options.configuration.save(copy(normalized));
    const snapshot = bindConfiguration(normalized);
    for (const listener of state.listeners) {
      // A subscriber must not turn an already-persisted change into a failed mutation.
      try { listener(); } catch { /* Subscriber failures are isolated. */ }
    }
    return snapshot;
  }
  function resolveSnapshot(snapshot: ConfigurationSnapshot, target: D.TargetRequest): ResolvedConfiguration {
    const resolved = snapshot.printers.find(p => p.printer.id === target.printerId);
    if (!resolved || target.routeId !== routeId(resolved.printer.id)) fail('invalid-target', 'Printer route is no longer configured');
    if (target.expectedConfigurationRevision !== undefined && target.expectedConfigurationRevision !== resolved.entry.revision) fail('stale-context', 'Printer configuration changed');
    return resolved;
  }
  async function resolve(target: D.TargetRequest) {
    return resolveSnapshot(await withConfiguration(loadConfiguration), target);
  }
  function capabilities(): D.PrinterCapabilities {
    return {
      revision: 'moonraker-domain-2', submission: unsupported,
      commands: {
        'jobs.start': supported({ sources: [{ storageId, versionCheck: 'unavailable' }], formats: ['gcode'], materialMapping: 'none', jobTimelapse: [] }),
        'jobs.pause': supported({}), 'jobs.resume': supported({}), 'jobs.cancel': supported({}), 'jobs.setSpeed': unsupported, 'hardware.refreshNozzles': unsupported, 'actions.invoke': unsupported,
        'thermal.setTarget': unsupported, 'fans.setSpeed': unsupported, 'lights.set': unsupported,
        'motion.home': unsupported, 'motion.jog': unsupported, 'extrusion.move': unsupported, 'tools.select': unsupported,
        'materials.load': unsupported, 'materials.unload': unsupported, 'materials.switch': unsupported,
        'materials.writeMetadata': unsupported, 'materials.refreshTag': unsupported,
        'drying.start': unsupported, 'drying.stop': unsupported, 'camera.setEnabled': unsupported,
        'camera.setDeviceTimelapse': unsupported, 'files.delete': unsupported,
      },
      cameras: [], currentPrintPreview: unsupported, webInterface: supported({ id: webId, name: 'Moonraker Web interface' }),
      files: {
        upload: supported([{ destination: { kind: 'default' }, formats: ['gcode'], maxBytes: 0x7fffffff, collisionPolicies: ['overwrite'] }]),
        list: unsupported, stat: unsupported, download: unsupported, preview: unsupported, changes: unsupported,
      },
      observations: {
        descriptor: supported({ delivery: ['on-demand'] }), firmware: supported({ delivery: ['on-demand'] }), status: supported({ delivery: ['on-demand'] }),
        thermal: unsupported, motion: unsupported, actuators: unsupported, materials: unsupported, cameras: unsupported, sensors: unsupported, alerts: unsupported,
      },
    };
  }
  function saved({ printer, entry }: ResolvedConfiguration): D.SavedPrinter {
    return {
      identity: { id: printer.id as D.Id<'printer'>, displayName: printer.displayName, manufacturer: null, model: null, serialNumber: null, externalRefs: [] },
      routes: [{
        id: routeId(printer.id), printerId: printer.id as D.Id<'printer'>, providerId, label: 'Moonraker',
        configurationRevision: entry.revision,
        management: { rename: true, configure: true, forget: true },
        configuration: { typeId, hostId: options.host.id, channel: 'lan', address: printer.apiBaseUrl,
          webInterfaceUrl: (printer.consoleUrl || null) as D.PrinterRouteConfiguration['webInterfaceUrl'],
          credentialRef: printer.apiKey ? `moonraker-key:${printer.id}` as D.Id<'credential'> : null },
        capabilities: capabilities(),
      }],
    };
  }
  function descriptor(printer: PrinterConfiguration, entry: ConfigurationEntry, firmware: D.Reading<readonly D.FirmwareComponent[]>): D.PrinterDescriptor {
    return { revision: entry.revision, identity: saved({ printer, entry }).identity, technology: 'fdm', firmware, buildVolume: null,
      topology: { revision: entry.revision, completeness: 'partial', motionGroups: [], extruders: [], nozzles: [], tools: [], heaters: [], fans: [], lights: [], cameras: [], sensors: [], materials: { units: [], slots: [], paths: [], dryers: [] } } };
  }
  function fileRef(printer: PrinterConfiguration, entry: ConfigurationEntry, path: string): D.RemoteFileRef {
    return { ...targetFor(printer.id), configurationRevision: entry.revision, storageId,
      fileId: `moonraker-file:${encodeURIComponent(path)}` as D.Id<'remote-file'>, contentRevision: null };
  }
  function filePath(selection: D.FileSelection, target: D.TargetRequest, entry: ConfigurationEntry): string {
    const file = selection.file;
    if (file.printerId !== target.printerId || file.routeId !== target.routeId || file.storageId !== storageId) fail('invalid-target', 'File belongs to another route or storage');
    if (file.configurationRevision !== entry.revision) fail('stale-context', 'File configuration changed');
    if (selection.consistency !== 'best-effort' || file.contentRevision !== null) fail('unsupported', 'Moonraker cannot verify this file version');
    if (!file.fileId.startsWith('moonraker-file:')) fail('invalid-target', 'Invalid Moonraker file reference');
    let path: string;
    try { path = decodeURIComponent(file.fileId.slice('moonraker-file:'.length)); } catch { fail('invalid-target', 'Invalid Moonraker file reference'); }
    if (!path || path.includes('\0') || path.split('/').includes('..')) fail('invalid-target', 'Invalid Moonraker file path');
    return path;
  }
  async function readStatus(printer: PrinterConfiguration, signal?: AbortSignal): Promise<D.PrinterObservationMap['status']> {
    const target = targetFor(printer.id);
    const result = await http.get(printer, '/printer/objects/query?print_stats&virtual_sdcard&extruder&heater_bed&fan', signal);
    if (!result.status || typeof result.status !== 'object' || Array.isArray(result.status)) fail('device-failed', 'Invalid printer status response');
    const status = record(result.status), stats = record(status.print_stats), sd = record(status.virtual_sdcard);
    const phase: D.PrintPhase | null = stats.state === 'standby' ? 'idle'
      : stats.state === 'complete' ? 'completed' : stats.state === 'error' ? 'failed'
      : stats.state === 'printing' || stats.state === 'paused' || stats.state === 'cancelled' ? stats.state : null;
    const operationalState = phase === 'printing' || phase === 'paused' ? 'busy'
      : phase === 'idle' || phase === 'completed' || phase === 'cancelled' ? 'ready' : phase === 'failed' ? 'error' : null;
    return {
      operationalState: operationalState ? known(target, operationalState) : unknown,
      activeToolIds: unknown,
      printStatus: {
        phase: phase ? known(target, phase) : unknown,
        name: phase === 'idle' ? known(target, null) : typeof stats.filename === 'string' && stats.filename.length > 0 ? known(target, stats.filename) : unknown,
        progressFraction: phase !== 'idle' && typeof sd.progress === 'number' && Number.isFinite(sd.progress) && sd.progress >= 0 && sd.progress <= 1 ? known(target, sd.progress) : unknown,
        remainingSeconds: unknown, taskId: unknown, stage: unknown, currentLayer: unknown, totalLayers: unknown, speedModeId: unknown,
      },
      actions: known(target, []),
    };
  }
  const observations: D.PrinterObservations = {
    read: (request, options) => safe(async () => {
      if (!request.topics.length || request.topics.some(topic => !(topic in capabilities().observations))) fail('invalid-request', 'Invalid observation topics');
      if (request.source !== 'cache' && request.source !== 'device') fail('invalid-request', 'Select cache or device');
      const { printer, entry } = await resolve(request.target);
      const observed: ConfigurationEntry['cache'] = {};
      if (request.source === 'device') {
        if (request.topics.some(topic => capabilities().observations[topic].kind !== 'supported')) fail('unsupported', unsupported.reason);
        if (request.topics.some(topic => topic === 'firmware') || request.topics.some(topic => topic === 'descriptor')) {
          const info = await http.get(printer, '/server/info', options?.signal);
          const firmware = typeof info.moonraker_version === 'string' ? known(request.target, [{ name: 'Moonraker', version: info.moonraker_version }]) : unknown;
          const nextDescriptor = descriptor(printer, entry, firmware);
          observed.firmware = firmware;
          observed.descriptor = known(request.target, nextDescriptor);
          entry.cache.firmware = retained(observed.firmware);
          entry.cache.descriptor = retained(observed.descriptor);
        }
        if (request.topics.some(topic => topic === 'status')) {
          observed.status = known(request.target, await readStatus(printer, options?.signal));
          entry.cache.status = retained(observed.status);
        }
      }
      const values = Object.fromEntries(request.topics.map(topic => {
        const reading = (request.source === 'device' ? observed[topic] : entry.cache[topic]) ?? unknown;
        return [topic, reading];
      })) as D.ObservationValues<typeof request.topics[number]>;
      return copy({ target: request.target, configurationRevision: entry.revision, values });
    }),
    watch: unsupportedStream,
  };
  async function validateCommand(target: D.TargetRequest, command: D.PrinterCommand, guard?: D.CommandEvaluation['basis']) {
    const resolved = await resolve(target);
    const cap = capabilities().commands[command.type];
    if (!cap || cap.kind !== 'supported') fail('unsupported', unsupported.reason);
    if (guard?.capabilityRevision !== undefined && guard.capabilityRevision !== capabilities().revision) fail('stale-context', 'Capability description changed');
    if (guard?.topologyRevision !== undefined && guard.topologyRevision !== resolved.entry.revision) fail('stale-context', 'Topology changed');
    if (guard?.expectedTaskId !== undefined) fail('unsupported', 'Device task identity comparison is unavailable');
    if (guard?.inventoryRevision !== undefined) fail('unsupported', 'Inventory comparison is unavailable');
    if (command.type === 'jobs.start') {
      filePath(command.params.source, target, resolved.entry);
      if (command.params.bindings.length || command.params.options?.timelapse?.length) fail('unsupported', 'Material mappings and timelapse options are unavailable');
    } else if (command.type === 'jobs.pause' || command.type === 'jobs.resume' || command.type === 'jobs.cancel') {
      if (!command.params || typeof command.params !== 'object' || Array.isArray(command.params) || Object.keys(command.params).length) fail('invalid-request', 'Current-print controls take no parameters');
    }
    return resolved;
  }
  const controls: D.PrinterControls = {
    evaluate: (target, command) => safe(async () => {
      try { await validateCommand(target, command); return { availability: { kind: 'available' }, basis: { capabilityRevision: capabilities().revision } } as D.CommandEvaluation; }
      catch (error) { return { availability: { kind: 'blocked', reasons: [publicError(error)] }, basis: {} } as D.CommandEvaluation; }
    }),
    submit: async request => {
      try {
        request = copy(request);
        const signature = requestSignature(request);
        const existing = operations.existing({ ...request.target, requestId: request.requestId }, signature);
        if (existing) return existing;
        const { printer, entry } = await validateCommand(request.target, request.command, request.guard);
        const repeated = operations.existing({ ...request.target, requestId: request.requestId }, signature);
        if (repeated) return repeated;
        const ref: D.OperationRef = { ...targetFor(printer.id), id: newId<'operation'>() };
        const operation = { ref, requestId: request.requestId, configurationRevision: entry.revision, revision: 0, updatedAtMs: Date.now(), kind: 'command', commandType: request.command.type, phase: { kind: 'queued' } } as D.CommandOperation;
        const submission = operations.register(operation, signature);
        const command = copy(request.command);
        void (async () => {
          try {
            operations.update(ref, previous => ({ ...previous, phase: { kind: 'sent' } }));
            if (command.type === 'jobs.start') await http.post(printer, '/printer/print/start', { filename: filePath(command.params.source, request.target, entry) });
            else await http.post(printer, '/printer/gcode/script', { script: { 'jobs.pause': 'PAUSE', 'jobs.resume': 'RESUME', 'jobs.cancel': 'CANCEL_PRINT' }[command.type as 'jobs.pause' | 'jobs.resume' | 'jobs.cancel'] });
            // Moonraker's HTTP acknowledgement does not establish physical completion.
            operations.update(ref, previous => ({ ...previous, phase: { kind: 'acknowledged' } }));
          } catch (error) {
            operations.update(ref, previous => ({ ...previous, phase: error instanceof MoonrakerFailure && error.uncertain
              ? { kind: 'outcome-unknown', reason: 'Printer command response was interrupted' }
              : { kind: 'failed', error: publicError(error) } }));
          }
        })();
        return submission;
      } catch (error) { return { kind: 'rejected', error: publicError(error) }; }
    },
  };
  const files: D.PrinterFiles = {
    listStorages: async () => rejected(), list: async () => rejected(), stat: async () => rejected(), download: async () => rejected(), listPreviews: async () => rejected(), watchChanges: unsupportedStream,
    upload: async (request, source) => {
      try {
        request = copy(request);
        const signature = requestSignature(request);
        const prior = operations.existing({ ...request.target, requestId: request.requestId }, signature);
        if (prior) return prior;
        const { printer, entry } = await resolve(request.target);
        if (request.destination.kind !== 'default' || request.format !== 'gcode' || request.collisionPolicy !== 'overwrite') fail('unsupported', 'Moonraker supports default G-code upload with explicit overwrite');
        if (!Number.isSafeInteger(request.sizeBytes) || request.sizeBytes < 0 || request.sizeBytes > 0x7fffffff || !request.fileName || /[\0]/.test(request.fileName)) fail('invalid-request', 'Invalid upload name or size');
        const repeated = operations.existing({ ...request.target, requestId: request.requestId }, signature);
        if (repeated) return repeated;
        const ref = { ...targetFor(printer.id), id: newId<'operation'>() };
        const controller = new AbortController();
        const submission = operations.register({ ref, requestId: request.requestId, configurationRevision: entry.revision, revision: 0, updatedAtMs: Date.now(), kind: 'upload', progress: null, remoteFileMayExist: false, phase: { kind: 'queued' } }, signature, controller);
        const input = copy(request);
        void (async () => {
          let dispatched = false;
          try {
            const bytes = new Uint8Array(input.sizeBytes);
            let offset = 0;
            const iterator = source.chunks[Symbol.asyncIterator]();
            let aborted!: () => void;
            const cancellation = new Promise<never>((_resolve, reject) => {
              aborted = () => reject(new MoonrakerFailure({ code: 'cancelled', message: 'Upload cancelled' }));
              controller.signal.addEventListener('abort', aborted, { once: true });
            });
            try {
              if (controller.signal.aborted) fail('cancelled', 'Upload cancelled');
              while (true) {
                const next = await Promise.race([iterator.next(), cancellation]);
                if (next.done) break;
                const chunk = next.value;
                if (!(chunk instanceof Uint8Array) || offset + chunk.length > bytes.length) fail('invalid-request', 'Upload size differs from its declaration');
                bytes.set(chunk, offset); offset += chunk.length;
              }
            } finally {
              controller.signal.removeEventListener('abort', aborted);
              // A stalled producer must not prevent cancellation from completing.
              void Promise.resolve(iterator.return?.()).catch(() => undefined);
            }
            if (controller.signal.aborted) fail('cancelled', 'Upload cancelled');
            if (offset !== bytes.length) fail('invalid-request', 'Upload size differs from its declaration');
            dispatched = true;
            operations.update(ref, previous => ({ ...previous, phase: { kind: 'running' } }));
            const path = await http.upload(printer, input.fileName, bytes, controller.signal, next => {
              if (controller.signal.aborted) return;
              operations.update(ref, previous => previous.kind === 'upload' ? { ...previous, progress: { sentBytes: next.loaded, totalBytes: next.total ?? null,
                stage: next.total !== undefined && next.loaded >= next.total ? 'awaiting-confirmation' : 'transferring' }, remoteFileMayExist: true } : previous);
            });
            const remote: D.RemoteFile = { ref: fileRef(printer, entry, path), directoryId: null, name: input.fileName, mimeType: 'text/x.gcode', sizeBytes: input.sizeBytes, createdAtMs: null, modifiedAtMs: null,
              metadata: { kind: 'print-file', format: 'gcode', estimatedDurationSeconds: null, materialKeys: null } };
            operations.update(ref, previous => previous.kind === 'upload' ? { ...previous, remoteFileMayExist: true, phase: { kind: 'completed', result: remote, confirmation: 'device-result' } } : previous);
          } catch (error) {
            operations.update(ref, previous => previous.kind === 'upload' ? { ...previous, remoteFileMayExist: dispatched,
              phase: controller.signal.aborted ? { kind: 'cancelled' } : error instanceof MoonrakerFailure && error.uncertain
                ? { kind: 'outcome-unknown', reason: 'Upload response was interrupted; a remote file may exist' } : { kind: 'failed', error: publicError(error) } } : previous);
          }
        })();
        return submission;
      } catch (error) { return { kind: 'rejected', error: publicError(error) }; }
    },
  };
  function mutate<T>(work: (snapshot: ConfigurationSnapshot) => Promise<T> | T): Promise<D.Result<T>> {
    return safe(() => withConfiguration(async () => work(await loadConfiguration())));
  }
  function configuration(config: D.PrinterRouteConfiguration, previous?: PrinterConfiguration): Omit<PrinterConfiguration, 'id' | 'displayName'> {
    if (config.typeId !== typeId || config.hostId !== options.host.id || config.channel !== 'lan') fail('unsupported', 'Unsupported Moonraker route configuration');
    if (config.credentialRef !== null && (!previous || config.credentialRef !== `moonraker-key:${previous.id}`)) fail('invalid-target', 'Credential reference is not available on this host');
    return { driverId: 'moonraker', apiBaseUrl: config.address ?? '', consoleUrl: config.webInterfaceUrl ?? '', apiKey: config.credentialRef === null ? '' : previous!.apiKey };
  }
  const service: D.PrinterService = {
    submissions: unsupportedSubmissions,
    operations: operations.api, controls, files, observations,
    media: { readStream: unsupportedStream, readCurrentPrintPreview: async () => rejected(), open: async () => rejected(), watch: unsupportedStream, renew: async () => rejected(), sendSignal: async () => rejected(), readContent: async () => rejected(), close: async () => rejected(), captureSnapshot: async () => rejected() },
    listProviders: async () => ({ ok: true, value: [{ id: providerId, name: 'Moonraker', hosts: [{ ...options.host, discovery: unsupported }] }] }),
    listTypes: async () => ({ ok: true, value: [{ id: typeId, providerId, name: 'Moonraker', description: 'Request-based Moonraker HTTP and native Web interface' }] }),
    listSaved: () => safe(async () => (await withConfiguration(loadConfiguration)).printers.map(saved)),
    onSavedChanged: listener => {
      if (options.configuration.onChanged) return options.configuration.onChanged(listener);
      state.listeners.add(listener);
      return () => { state.listeners.delete(listener); };
    },
    describe: target => safe(async () => { const { entry } = await resolve(target); return copy({ target, configurationRevision: entry.revision, capabilities: capabilities(), descriptor: entry.cache.descriptor?.kind === 'known' ? { ...entry.cache.descriptor, freshness: 'stale' } : unknown }); }),
    webInterfaces: {
      describe: target => safe(async () => { await resolve(target); return { ...target, capability: capabilities().webInterface, availability: { kind: 'unknown', reason: 'Not probed' }, assessedAtMs: Date.now(), freshness: 'fresh' } as D.WebInterfaceDescription; }),
      resolve: request => safe(async () => { const { printer } = await resolve(request.target); if (request.interfaceId !== undefined && request.interfaceId !== webId) fail('invalid-target', 'Web interface entry changed'); return { ...request.target, interfaceId: webId, url: (printer.consoleUrl || printer.apiBaseUrl) as D.WebInterfaceLaunch['url'], expiresAtMs: null }; }),
    },
    add: request => mutate(async snapshot => {
      const doc = snapshot.document;
      if (request.routes.length !== 1) fail('unsupported', 'Moonraker configuration supports one route per saved entry');
      const signature = requestSignature([request.displayName, request.routes]);
      const previous = state.additions.get(request.requestId);
      if (previous) {
        if (previous.signature !== signature) fail('invalid-request', 'Request identity was already used with different parameters');
        const printer = snapshot.printers.find(p => p.printer.id === previous.printerId);
        if (!printer) fail('invalid-target', 'Previously added printer was removed');
        return saved(printer);
      }
      const id = newId<'printer'>();
      const printer = { id, displayName: request.displayName, ...configuration(request.routes[0]) };
      const next = await saveConfiguration({ ...doc, printers: [...doc.printers, printer] });
      state.additions.set(request.requestId, { signature, printerId: id });
      return saved(resolveSnapshot(next, targetFor(id)));
    }),
    updateRoute: request => mutate(async snapshot => {
      const { printer } = resolveSnapshot(snapshot, request.target);
      const doc = snapshot.document;
      const next = await saveConfiguration({ ...doc, printers: doc.printers.map(p => p.id === printer.id ? { ...printer, ...configuration(request.configuration, printer) } : p) });
      return saved(resolveSnapshot(next, targetFor(printer.id))).routes[0];
    }),
    rename: (target, displayName) => mutate(async snapshot => {
      const { printer: { id } } = resolveSnapshot(snapshot, target);
      const doc = snapshot.document;
      const next = await saveConfiguration({ ...doc, printers: doc.printers.map(p => p.id === id ? { ...p, displayName } : p) });
      return saved(resolveSnapshot(next, targetFor(id)));
    }),
    forget: target => mutate(async snapshot => {
      const { printer } = resolveSnapshot(snapshot, target);
      await saveConfiguration({ ...snapshot.document, printers: snapshot.document.printers.filter(p => p.id !== printer.id) });
      return null;
    }),
    discover: unsupportedStream,
    adopt: async () => rejected(),
    authorize: async () => rejected(),
  };
  return service;
}
