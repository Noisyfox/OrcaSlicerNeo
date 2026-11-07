import { U1ObservationHub } from './snapmaker-monitor';
import { u1PreferenceScripts, verifyU1Preferences } from './snapmaker-preferences';
import { readU1Device, u1DeviceValues, u1DeviceCapabilities, u1DeviceCommand, u1PrintStage, type U1DeviceSnapshot } from './snapmaker-device';
import { U1Submissions } from './snapmaker-submissions';
import { prepareU1Submission, u1PreparationFromDevice, type U1PreparationSnapshot } from './snapmaker-preparation';
import { u1MaterialInventory, matchU1Materials, type FilamentMatcher } from './snapmaker-observation';
import { unsupportedSubmissions } from './submission';
/** Shared request-based HTTP service with provider-owned routes and operation records. */
import { BUILT_IN_PRINTER_DRIVER_IDS, normalizePrinterConfiguration, normalizePrinterConfigurationDocument, type PrinterConfiguration, type PrinterConfigurationDocument } from './configuration';
import type { PrinterTransport } from './transport';
import type * as D from './domain';
import { MoonrakerHttp, MoonrakerFailure, fail, publicError, record } from './moonraker-http';
import { OperationStore, copy, newId, requestSignature, streamError } from './operations';

export interface MoonrakerServiceOptions {
  /** Snapmaker's read-only native preset matcher; raw device controls need no catalogue. */
  matchFilaments?: FilamentMatcher;
  configuration: { onChanged?(listener: () => void): () => void; load(): Promise<PrinterConfigurationDocument>; save(document: PrinterConfigurationDocument): Promise<void> };
  transport: PrinterTransport;
  host: D.AgentHost;
}
const storageId = 'gcodes' as D.Id<'storage'>;
const unsupported = { kind: 'unsupported', layer: 'adapter', reason: 'Not implemented by this HTTP adapter' } as const;
const unknown = { kind: 'unknown', reason: 'not-reported' } as const;
const rejected = (): D.Result<never> => ({ ok: false, error: { code: 'unsupported', message: unsupported.reason } });
const unsupportedStream = async function* (): AsyncIterable<never> { throw streamError(unsupported.reason); };
const supported = <C extends object>(constraints: C): D.Capability<C> => ({ kind: 'supported', constraints });
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
  snapmakerPreparation?: U1PreparationSnapshot;
  snapmakerDevice?: U1DeviceSnapshot;
  materialOperationActive?: boolean;
  observationHub?: U1ObservationHub<U1DeviceSnapshot>;
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
const authorities = new WeakMap<object, { configurations: Map<string, ConfigurationEntry>; operations: Map<string, OperationStore>; snapmakerSubmissions?: U1Submissions; additions: Map<string, { signature: string; printerId: string }>; configurationQueue: Promise<void>; listeners: Set<() => void> }>();

export function createMoonrakerService(options: MoonrakerServiceOptions): D.PrinterService {
  return createHttpPrinterService(options, 'moonraker');
}
export function createSnapmakerService(options: MoonrakerServiceOptions): D.PrinterService {
  return createHttpPrinterService(options, 'snapmaker');
}
function createHttpPrinterService(options: MoonrakerServiceOptions, driver: PrinterConfiguration['driverId']): D.PrinterService {
  const providerId = driver as D.Id<'provider'>;
  const typeId = driver as D.Id<'printer-type'>;
  const webId = `${driver}-web` as D.Id<'web-interface'>;
  const name = driver === 'snapmaker' ? 'Snapmaker' : 'Moonraker';
  const configurationForm = supported<D.PrinterConfigurationForm>({ hostId: options.host.id, supportsModelSelection: true, fields: [
    { key: 'apiBaseUrl', label: 'API base URL', type: 'url', required: true, placeholder: 'http://printer.local:7125/', defaultValue: '' },
    { key: 'consoleUrl', label: 'Console URL', type: 'url', required: false, placeholder: 'Uses API base URL when blank', defaultValue: '' },
    { key: 'apiKey', label: 'API key', type: 'password', required: false, placeholder: '', defaultValue: '' },
  ] });
  const routeId = (id: string) => `${driver}:${id}` as D.Id<'route'>;
  const targetFor = (id: string): D.PrinterTarget => ({ printerId: id as D.Id<'printer'>, routeId: routeId(id) });
  const filePrefix = `${driver}-file:`;

  let authority = authorities.get(options.configuration);
  if (!authority) {
    authority = { configurations: new Map(), operations: new Map(), additions: new Map(), configurationQueue: Promise.resolve(), listeners: new Set() };
    authorities.set(options.configuration, authority);
  }
  const state = authority;
  const http = new MoonrakerHttp(options.transport);
  const matchFilaments = options.matchFilaments;
  if (!state.operations.has(driver)) state.operations.set(driver, new OperationStore());
  const operations = state.operations.get(driver)!;
  /** Only local repository work is queued; printer I/O retains its resolved snapshot. */
  function withConfiguration<T>(work: () => T | Promise<T>): Promise<T> {
    const next = state.configurationQueue.then(work);
    state.configurationQueue = next.then(() => undefined, () => undefined);
    return next;
  }
  /** Called within the configuration queue, with a normalized, owned document. */
  function bindConfiguration(doc: PrinterConfigurationDocument): ConfigurationSnapshot {
    for (const id of state.configurations.keys()) if (!doc.printers.some(p => p.id === id)) state.configurations.delete(id);
    const printers = doc.printers.filter(printer => printer.driverId === driver).map(printer => {
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
  function capabilities(entry?: ConfigurationEntry): D.PrinterCapabilities {
    return {
      revision: `${driver}-domain-5`, ...(driver === 'snapmaker' ? { observationLifetime: 'visible-consumers' as const } : {}), submission: driver === 'snapmaker' ? supported({ formats: ['gcode'] as const, failurePolicy: 'retry' as const }) : unsupported,
      commands: {
        'jobs.start': driver === 'snapmaker' ? unsupported : supported({ sources: [{ storageId }], formats: ['gcode'], materialMapping: 'none', jobTimelapse: [] }),
        'jobs.pause': supported({}), 'jobs.resume': supported({}), 'jobs.cancel': supported({}), 'jobs.setSpeed': unsupported, 'jobs.skipObjects': unsupported, 'hardware.refreshNozzles': unsupported, 'actions.invoke': unsupported,
        'thermal.setTarget': unsupported, 'fans.setSpeed': unsupported, 'lights.set': unsupported,
        'motion.home': unsupported, 'motion.jog': unsupported, 'extrusion.move': unsupported, 'tools.select': unsupported,
        'materials.load': unsupported, 'materials.unload': unsupported, 'materials.switch': unsupported,
        'materials.writeMetadata': unsupported, 'materials.configure': unsupported, 'materials.refreshTag': unsupported,
        'drying.start': unsupported, 'drying.stop': unsupported, 'camera.setEnabled': unsupported,
        'camera.setDeviceTimelapse': unsupported, 'preferences.set': unsupported, 'files.delete': unsupported,
        ...(driver === 'snapmaker' ? u1DeviceCapabilities(entry?.snapmakerDevice) : {}),
      },
      cameras: [], currentPrintPreview: unsupported, webInterface: supported({ id: webId, name: `${name} Web interface` }),
      files: {
        upload: supported([{ destination: { kind: 'default' }, formats: ['gcode'], maxBytes: 0x7fffffff, collisionPolicies: ['overwrite'] }]),
        list: unsupported, stat: unsupported, download: unsupported, preview: unsupported, changes: unsupported,
      },
      observations: {
        preferences: driver === 'snapmaker' ? supported({ delivery: driver === 'snapmaker' ? ['poll', 'on-demand'] : ['on-demand'] }) : unsupported,
        descriptor: supported({ delivery: driver === 'snapmaker' ? ['poll', 'on-demand'] : ['on-demand'] }), firmware: supported({ delivery: ['on-demand'] }), status: supported({ delivery: driver === 'snapmaker' ? ['poll', 'on-demand'] : ['on-demand'] }),
        thermal: driver === 'snapmaker' ? supported({ delivery: driver === 'snapmaker' ? ['poll', 'on-demand'] : ['on-demand'] }) : unsupported, motion: unsupported, actuators: driver === 'snapmaker' ? supported({ delivery: driver === 'snapmaker' ? ['poll', 'on-demand'] : ['on-demand'] }) : unsupported, materials: driver === 'snapmaker' ? supported({ delivery: driver === 'snapmaker' ? ['poll', 'on-demand'] : ['on-demand'] }) : unsupported, cameras: unsupported, sensors: driver === 'snapmaker' ? supported({ delivery: driver === 'snapmaker' ? ['poll', 'on-demand'] : ['on-demand'] }) : unsupported, alerts: unsupported, printObjects: unsupported,
      },
    };
  }
  function saved({ printer, entry }: ResolvedConfiguration): D.SavedPrinter {
    return {
      identity: { id: printer.id as D.Id<'printer'>, displayName: printer.displayName, manufacturer: null, model: null, serialNumber: null, externalRefs: [] },
      ...(printer.printerModel ? { configuredModel: { ...printer.printerModel } } : {}),
      routes: [{
        id: routeId(printer.id), printerId: printer.id as D.Id<'printer'>, providerId, label: name,
        configurationRevision: entry.revision,
        management: { rename: true, configure: true, forget: true },
        configuration: { typeId, hostId: options.host.id, channel: 'lan', address: printer.apiBaseUrl,
          webInterfaceUrl: (printer.consoleUrl || null) as D.PrinterRouteConfiguration['webInterfaceUrl'],
          credentialRef: printer.apiKey ? `${driver}-key:${printer.id}` as D.Id<'credential'> : null },
        capabilities: capabilities(entry),
      }],
    };
  }
  function descriptor(printer: PrinterConfiguration, entry: ConfigurationEntry, firmware: D.Reading<readonly D.FirmwareComponent[]>): D.PrinterDescriptor {
    return { revision: entry.revision, identity: saved({ printer, entry }).identity, technology: 'fdm', firmware, buildVolume: null,
      topology: { revision: entry.revision, completeness: 'partial', motionGroups: [], extruders: [], nozzles: [], tools: [], heaters: [], fans: [], lights: [], cameras: [], sensors: [], materials: { units: [], slots: [], paths: [], dryers: [] } } };
  }
  function fileRef(printer: PrinterConfiguration, entry: ConfigurationEntry, path: string): D.RemoteFileRef {
    return { ...targetFor(printer.id), configurationRevision: entry.revision, storageId,
      fileId: `${filePrefix}${encodeURIComponent(path)}` as D.Id<'remote-file'> };
  }
  function filePath(file: D.RemoteFileRef, target: D.TargetRequest, entry: ConfigurationEntry): string {
    if (file.printerId !== target.printerId || file.routeId !== target.routeId || file.storageId !== storageId) fail('invalid-target', 'File belongs to another route or storage');
    if (file.configurationRevision !== entry.revision) fail('stale-context', 'File configuration changed');
    if (!file.fileId.startsWith(filePrefix)) fail('invalid-target', 'Invalid Moonraker file reference');
    let path: string;
    try { path = decodeURIComponent(file.fileId.slice(filePrefix.length)); } catch { fail('invalid-target', 'Invalid Moonraker file reference'); }
    if (!path || path.includes('\0') || path.split('/').includes('..')) fail('invalid-target', 'Invalid Moonraker file path');
    return path;
  }
  async function readStatus(printer: PrinterConfiguration, signal?: AbortSignal, reported?: Record<string, unknown>): Promise<D.PrinterObservationMap['status']> {
    const target = targetFor(printer.id);
    const result = reported ? { status: reported } : await http.get(printer, '/printer/objects/query?print_stats&virtual_sdcard&extruder&heater_bed&fan', signal);
    if (!result.status || typeof result.status !== 'object' || Array.isArray(result.status)) fail('device-failed', 'Invalid printer status response');
    const status = record(result.status), stats = record(status.print_stats), sd = record(status.virtual_sdcard);
    const phase: D.PrintPhase | null = stats.state === 'standby' ? 'idle'
      : stats.state === 'complete' ? 'completed' : stats.state === 'error' ? 'failed'
      : stats.state === 'printing' || stats.state === 'paused' || stats.state === 'cancelled' ? stats.state : null;
    const operationalState = phase === 'printing' || phase === 'paused' ? 'busy'
      : phase === 'idle' || phase === 'completed' || phase === 'cancelled' ? 'ready' : phase === 'failed' ? 'error' : null;
    const layerInfo = record(stats.info);
    const currentLayer = layerInfo.current_layer, totalLayers = layerInfo.total_layer;
    const hasCurrentLayer = typeof currentLayer === 'number' && Number.isSafeInteger(currentLayer) && currentLayer >= 0;
    const hasTotalLayers = typeof totalLayers === 'number' && Number.isSafeInteger(totalLayers) && totalLayers > 0;
    const stage = driver === 'snapmaker' ? u1PrintStage(status) : undefined;
    return {
      operationalState: operationalState ? known(target, operationalState) : unknown,
      activeToolIds: unknown,
      printStatus: {
        phase: phase ? known(target, phase) : unknown,
        name: phase === 'idle' ? known(target, null) : typeof stats.filename === 'string' && stats.filename.length > 0 ? known(target, stats.filename) : unknown,
        progressFraction: phase !== 'idle' && typeof sd.progress === 'number' && Number.isFinite(sd.progress) && sd.progress >= 0 && sd.progress <= 1 ? known(target, sd.progress) : unknown,
        remainingSeconds: unknown, taskId: unknown, stage: stage === undefined ? unknown : known(target, stage),
        currentLayer: phase !== 'idle' && hasCurrentLayer ? known(target, currentLayer) : unknown,
        totalLayers: phase !== 'idle' && hasTotalLayers ? known(target, totalLayers) : unknown,
        speedModeId: unknown,
      },
      actions: known(target, []),
    };
  }
  function hub(printer: PrinterConfiguration, entry: ConfigurationEntry) {
    if (!entry.observationHub) entry.observationHub = new U1ObservationHub(async signal => {
      const { printer: currentPrinter } = await resolve({ ...targetFor(printer.id), expectedConfigurationRevision: entry.revision });
      const snapshot = await readU1Device(http, currentPrinter, signal);
      entry.snapmakerDevice = snapshot;
      const target = targetFor(printer.id);
      const values = u1DeviceValues(snapshot, target, entry.revision, descriptor(currentPrinter, entry, entry.cache.firmware ?? unknown), currentPrinter.printerModel);
      if (values.materials && matchFilaments) await matchU1Materials(values.materials, matchFilaments, snapshot.status);
      values.status = await readStatus(currentPrinter, signal, snapshot.status);
      for (const [topic, value] of Object.entries(values)) Object.assign(entry.cache, { [topic]: known(target, value) });
      if (values.materials) entry.snapmakerPreparation = u1PreparationFromDevice(snapshot.status, snapshot.commands, target, entry.revision, snapshot.receivedAtMs);
      return snapshot;
    }, () => {
      for (const [topic, value] of Object.entries(entry.cache)) Object.assign(entry.cache, { [topic]: retained(value) });
      if (entry.snapmakerPreparation) entry.snapmakerPreparation = { ...entry.snapmakerPreparation, inventory: retained(entry.snapmakerPreparation.inventory) };
    });
    return entry.observationHub;
  }
  const observations: D.PrinterObservations = {
    read: (request, options) => safe(async () => {
      if (!request.topics.length || request.topics.some(topic => !(topic in capabilities().observations))) fail('invalid-request', 'Invalid observation topics');
      if (request.source !== 'cache' && request.source !== 'device') fail('invalid-request', 'Select cache or device');
      const { printer, entry } = await resolve(request.target);
      const observed: ConfigurationEntry['cache'] = {};
      if (request.source === 'device') {
        if (request.topics.some(topic => capabilities().observations[topic].kind !== 'supported')) fail('unsupported', unsupported.reason);
        if (driver === 'snapmaker') {
          await hub(printer, entry).refresh();
          Object.assign(observed, entry.cache);
          // Explicit reads return current values even when there is no ongoing consumer.
          const values = u1DeviceValues(entry.snapmakerDevice!, request.target, entry.revision, descriptor(printer, entry, entry.cache.firmware ?? unknown), printer.printerModel);
          if (values.materials && matchFilaments) await matchU1Materials(values.materials, matchFilaments, entry.snapmakerDevice!.status);
          values.status = await readStatus(printer, options?.signal, entry.snapmakerDevice!.status);
          for (const [topic, value] of Object.entries(values)) Object.assign(observed, { [topic]: known(request.target, value) });
          if (request.topics.some(topic => topic === 'materials') && !values.materials) fail('unsupported', 'U1 material information is unavailable');
        }
        if (request.topics.some(topic => topic === 'firmware') || driver !== 'snapmaker' && request.topics.some(topic => topic === 'descriptor')) {
          const info = await http.get(printer, '/server/info', options?.signal);
          const firmware = typeof info.moonraker_version === 'string' ? known(request.target, [{ name: 'Moonraker', version: info.moonraker_version }]) : unknown;
          const nextDescriptor = descriptor(printer, entry, firmware);
          observed.firmware = firmware;
          observed.descriptor = known(request.target, nextDescriptor);
          entry.cache.firmware = retained(observed.firmware);
          entry.cache.descriptor = retained(observed.descriptor);
        }
        if (driver !== 'snapmaker' && request.topics.some(topic => topic === 'status')) {
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
    watch: driver !== 'snapmaker' ? unsupportedStream : async function* (request, readOptions) {
      const { printer, entry } = await resolve(request.target);
      if (!request.topics.length || request.topics.some(topic => capabilities(entry).observations[topic]?.kind !== 'supported')) fail('unsupported', 'Observation topic unavailable');
      for await (const _update of hub(printer, entry).watch(readOptions?.signal)) {
        const values = Object.fromEntries(request.topics.map(topic => [topic, entry.cache[topic] ?? unknown])) as D.ObservationValues<typeof request.topics[number]>;
        yield { type: 'snapshot', cursor: newId<'cursor'>() as unknown as D.ObservationCursor, snapshot: { target: request.target, configurationRevision: entry.revision, values: copy(values) } };
      }
    },
  };
  async function validateCommand(target: D.TargetRequest, command: D.PrinterCommand, guard?: D.CommandEvaluation['basis']) {
    const resolved = await resolve(target);
    if (driver === 'snapmaker' && !command.type.startsWith('jobs.')) {
      if (!resolved.entry.snapmakerDevice) await hub(resolved.printer, resolved.entry).refresh();
      u1DeviceCommand(resolved.entry.snapmakerDevice!, command);
    }
    const cap = capabilities(resolved.entry).commands[command.type];
    if (!cap || cap.kind !== 'supported') fail('unsupported', unsupported.reason);
    if (guard?.capabilityRevision !== undefined && guard.capabilityRevision !== capabilities().revision) fail('stale-context', 'Capability description changed');
    if (guard?.topologyRevision !== undefined && guard.topologyRevision !== resolved.entry.revision) fail('stale-context', 'Topology changed');
    if (guard?.expectedTaskId !== undefined) fail('unsupported', 'Device task identity comparison is unavailable');
    if (guard?.inventoryRevision !== undefined) fail('unsupported', 'Inventory comparison is unavailable');
    if (command.type === 'jobs.start') {
      filePath(command.params.source, target, resolved.entry);
      if (command.params.bindings.length || command.params.inspection || Object.keys(command.params.options ?? {}).length || command.params.acknowledgedIssues?.length || command.params.allowAbnormalStorage) fail('unsupported', 'Prepared device-file printing is unavailable for this agent');
    } else if (command.type === 'jobs.pause' || command.type === 'jobs.resume' || command.type === 'jobs.cancel') {
      if (!command.params || typeof command.params !== 'object' || Array.isArray(command.params) || Object.keys(command.params).length) fail('invalid-request', 'Current-print controls take no parameters');
    }
    return resolved;
  }
  const controls: D.PrinterControls = {
    evaluate: (target, command) => safe(async () => {
      try { await validateCommand(target, command); return { availability: { kind: 'available' }, warnings: [], basis: { capabilityRevision: capabilities().revision } } as D.CommandEvaluation; }
      catch (error) { return { availability: { kind: 'blocked', reasons: [publicError(error)] }, warnings: [], basis: {} } as D.CommandEvaluation; }
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
        const materialOperation = driver === 'snapmaker' && ['materials.load', 'materials.unload'].includes(request.command.type);
        if (materialOperation && entry.materialOperationActive) fail('busy', 'Another individual material operation is still running');
        if (materialOperation) entry.materialOperationActive = true;
        const ref: D.OperationRef = { ...targetFor(printer.id), id: newId<'operation'>() };
        const operation = { ref, requestId: request.requestId, configurationRevision: entry.revision, revision: 0, updatedAtMs: Date.now(), kind: 'command', steps: [], commandType: request.command.type, phase: { kind: 'queued' } } as D.CommandOperation;
        const submission = operations.register(operation, signature);
        const command = copy(request.command);
        const releaseObservation = driver === 'snapmaker' ? hub(printer, entry).retain() : () => {};
        void (async () => {
          try {
            operations.update(ref, previous => ({ ...previous, phase: { kind: 'sent' } }));
            if (command.type === 'jobs.start') await http.post(printer, '/printer/print/start', { filename: filePath(command.params.source, request.target, entry) });
            else if (driver === 'snapmaker' && command.type === 'preferences.set') {
              entry.snapmakerDevice = await readU1Device(http, printer);
              for (const script of u1PreferenceScripts(entry.snapmakerDevice, command.params.changes)) await http.post(printer, '/printer/gcode/script', { script });
              entry.snapmakerDevice = await readU1Device(http, printer);
              verifyU1Preferences(entry.snapmakerDevice, command.params.changes);
            }
            else if (driver === 'snapmaker' && !command.type.startsWith('jobs.')) await http.post(printer, '/printer/gcode/script', { script: u1DeviceCommand(entry.snapmakerDevice!, command) });
            else await http.post(printer, '/printer/gcode/script', { script: { 'jobs.pause': 'PAUSE', 'jobs.resume': 'RESUME', 'jobs.cancel': 'CANCEL_PRINT' }[command.type as 'jobs.pause' | 'jobs.resume' | 'jobs.cancel'] });
            // Moonraker's HTTP acknowledgement does not establish physical completion.
            operations.update(ref, previous => ({ ...previous, phase: { kind: 'acknowledged' } }));
          } catch (error) {
            operations.update(ref, previous => ({ ...previous, phase: error instanceof MoonrakerFailure && error.uncertain
              ? { kind: 'outcome-unknown', reason: 'Printer command response was interrupted' }
              : { kind: 'failed', error: publicError(error) } }));
          } finally { if (materialOperation) entry.materialOperationActive = false; releaseObservation(); }
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
        if (request.destination.kind !== 'default' || request.format !== 'gcode' || request.collisionPolicy !== 'overwrite') fail('unsupported', 'This adapter supports default G-code upload with explicit overwrite');
        if (!Number.isSafeInteger(request.sizeBytes) || request.sizeBytes < 0 || request.sizeBytes > 0x7fffffff || !request.fileName || /[\0]/.test(request.fileName)) fail('invalid-request', 'Invalid upload name or size');
        const repeated = operations.existing({ ...request.target, requestId: request.requestId }, signature);
        if (repeated) return repeated;
        const ref = { ...targetFor(printer.id), id: newId<'operation'>() };
        const controller = new AbortController();
        const submission = operations.register({ ref, requestId: request.requestId, configurationRevision: entry.revision, revision: 0, updatedAtMs: Date.now(), kind: 'upload', progress: null, remoteFileMayExist: false, phase: { kind: 'queued' } }, signature, controller);
        const input = copy(request);
        const releaseObservation = driver === 'snapmaker' ? hub(printer, entry).retain() : () => {};
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
          } finally { releaseObservation(); }
        })();
        return submission;
      } catch (error) { return { kind: 'rejected', error: publicError(error) }; }
    },
  };
  function mutate<T>(work: (snapshot: ConfigurationSnapshot) => Promise<T> | T): Promise<D.Result<T>> {
    return safe(() => withConfiguration(async () => work(await loadConfiguration())));
  }
  function configuration(config: D.PrinterRouteConfiguration, previous?: PrinterConfiguration): Omit<PrinterConfiguration, 'id' | 'displayName'> {
    if (config.typeId !== typeId || config.hostId !== options.host.id || config.channel !== 'lan') fail('unsupported', 'Unsupported HTTP printer route configuration');
    if (config.credentialRef !== null && (!previous || config.credentialRef !== `${driver}-key:${previous.id}`)) fail('invalid-target', 'Credential reference is not available on this host');
    return { driverId: driver, apiBaseUrl: config.address ?? '', consoleUrl: config.webInterfaceUrl ?? '', apiKey: config.credentialRef === null ? '' : previous!.apiKey };
  }
  if (driver === 'snapmaker' && !state.snapmakerSubmissions) state.snapmakerSubmissions = new U1Submissions({ http,
    retainObservation: async target => { const { printer, entry } = await resolve(target); return hub(printer, entry).retain(); },
    resolve: async target => { const { printer, entry } = await resolve(target); return { printer, revision: entry.revision }; },
    prepare: (request, readOptions) => safe(async () => {
      const { printer, entry } = await resolve(request.target);
      if (!entry.snapmakerPreparation || request.checkRecording)
        await hub(printer, entry).refresh();
      const snapshot = entry.snapmakerDevice!;
      entry.snapmakerPreparation = u1PreparationFromDevice(snapshot.status, snapshot.commands, request.target, entry.revision, snapshot.receivedAtMs);
      if (hub(printer, entry).unavailable) entry.snapmakerPreparation.inventory = retained(entry.snapmakerPreparation.inventory);
      return prepareU1Submission(request, entry.snapmakerPreparation, entry.revision);
    }),
  });
  const service: D.PrinterService = {
    submissions: driver === 'snapmaker' ? state.snapmakerSubmissions! : unsupportedSubmissions,
    remotePrints: { inspect: async () => rejected(), prepare: async () => rejected(), release: async () => rejected() },
    operations: operations.api, controls, files, observations,
    media: { readPrintObjectMap: async () => rejected(), readStream: unsupportedStream, readCurrentPrintPreview: async () => rejected(), open: async () => rejected(), watch: unsupportedStream, renew: async () => rejected(), sendSignal: async () => rejected(), readContent: async () => rejected(), close: async () => rejected(), captureSnapshot: async () => rejected() },
    listProviders: async () => ({ ok: true, value: [{ id: providerId, name, hosts: [{ ...options.host, discovery: unsupported }] }] }),
    configurations: {
      read: target => mutate(async snapshot => {
        const { printer } = resolveSnapshot(snapshot, target);
        return { typeId, displayName: printer.displayName,
          values: { apiBaseUrl: printer.apiBaseUrl, consoleUrl: printer.consoleUrl, apiKey: printer.apiKey },
          printerModel: printer.printerModel ?? null };
      }),
      save: request => mutate(async snapshot => {
        const requestedDriver = BUILT_IN_PRINTER_DRIVER_IDS.find(value => value === request.typeId);
        if (!requestedDriver || request.hostId !== options.host.id) fail('unsupported', 'Unsupported manual printer configuration');
        if (Object.keys(request.values).some(key => !['apiBaseUrl', 'consoleUrl', 'apiKey'].includes(key)))
          fail('invalid-request', 'Unknown printer configuration field');
        const signature = requestSignature(request);
        const requestKey = `${driver}:configuration:${request.requestId}`;
        const previousRequest = state.additions.get(requestKey);
        if (previousRequest) {
          if (previousRequest.signature !== signature) fail('invalid-request', 'Request identity was already used with different parameters');
          if (!snapshot.document.printers.some(printer => printer.id === previousRequest.printerId)) fail('invalid-target', 'Previously configured printer was removed');
          return null;
        }
        const previous = request.target ? resolveSnapshot(snapshot, request.target).printer : undefined;
        const printerId = previous?.id ?? newId<'printer'>();
        const printer = normalizePrinterConfiguration({ id: printerId, driverId: requestedDriver,
          displayName: request.displayName, apiBaseUrl: request.values.apiBaseUrl,
          consoleUrl: request.values.consoleUrl, apiKey: request.values.apiKey,
          ...(request.printerModel ? { printerModel: request.printerModel } : {}) });
        const document = snapshot.document;
        const printers = previous ? document.printers.map(value => value.id === printerId ? printer : value) : [...document.printers, printer];
        await saveConfiguration({ ...document, printers });
        state.additions.set(requestKey, { signature, printerId });
        return null;
      }),
    },
    listTypes: async () => ({ ok: true, value: [{ id: typeId, providerId, name, description: `${name} HTTP and Web interface`, manualConfiguration: configurationForm }] }),
    listSaved: () => safe(async () => (await withConfiguration(loadConfiguration)).printers.map(saved)),
    onSavedChanged: listener => {
      if (options.configuration.onChanged) return options.configuration.onChanged(listener);
      state.listeners.add(listener);
      return () => { state.listeners.delete(listener); };
    },
    describe: target => safe(async () => { const { entry } = await resolve(target); return copy({ target, configurationRevision: entry.revision, capabilities: capabilities(entry), descriptor: entry.cache.descriptor?.kind === 'known' ? { ...entry.cache.descriptor, freshness: 'stale' } : unknown }); }),
    webInterfaces: {
      describe: target => safe(async () => { await resolve(target); return { ...target, capability: capabilities().webInterface, availability: { kind: 'unknown', reason: 'Not probed' }, assessedAtMs: Date.now(), freshness: 'fresh' } as D.WebInterfaceDescription; }),
      resolve: request => safe(async () => { const { printer } = await resolve(request.target); if (request.interfaceId !== undefined && request.interfaceId !== webId) fail('invalid-target', 'Web interface entry changed'); return { ...request.target, interfaceId: webId, url: (printer.consoleUrl || printer.apiBaseUrl) as D.WebInterfaceLaunch['url'], expiresAtMs: null }; }),
    },
    add: request => mutate(async snapshot => {
      const doc = snapshot.document;
      if (request.routes.length !== 1) fail('unsupported', 'HTTP printer configuration supports one route per saved entry');
      const signature = requestSignature([request.displayName, request.routes]);
      const previous = state.additions.get(`${driver}:${request.requestId}`);
      if (previous) {
        if (previous.signature !== signature) fail('invalid-request', 'Request identity was already used with different parameters');
        const printer = snapshot.printers.find(p => p.printer.id === previous.printerId);
        if (!printer) fail('invalid-target', 'Previously added printer was removed');
        return saved(printer);
      }
      const id = newId<'printer'>();
      const printer = { id, displayName: request.displayName, ...configuration(request.routes[0]) };
      const next = await saveConfiguration({ ...doc, printers: [...doc.printers, printer] });
      state.additions.set(`${driver}:${request.requestId}`, { signature, printerId: id });
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
