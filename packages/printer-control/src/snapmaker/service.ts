/** Snapmaker orchestration and host-lifetime U1 state, built on shared HTTP infrastructure. */
import type * as D from '../domain';
import type { PrinterConfiguration } from '../configuration';
import { createHttpPrinterService, known, retained, safe, supported, unknown, unsupported, type HttpServiceOptions, type HttpServiceContext, type HttpServiceBehavior, type ConfigurationEntry } from '../http-service';
import { fail, MoonrakerFailure } from '../moonraker-http';
import { copy, newId } from '../operations';
import { U1ObservationHub } from './monitor';
import { u1PreferenceScripts, verifyU1Preferences } from './preferences';
import { readU1Device, u1DeviceValues, u1DeviceCapabilities, u1DeviceCommand, u1PrintStage, u1ActiveToolIds, u1HomedAxes, type U1DeviceSnapshot } from './device';
import { U1PrintTask } from './task';
import { U1Submissions } from './submissions';
import { prepareU1Submission, u1PreparationFromDevice, type U1PreparationSnapshot } from './preparation';
import { matchU1Materials, type FilamentMatcher } from './observation';
import { U1_CAMERA_ID, u1CameraCapability } from './camera';
import { U1Storage, u1DeleteCapability, u1StorageCapabilities } from './storage';
import type { U1TimelapseTransport } from './timelapse';

export interface SnapmakerServiceOptions extends HttpServiceOptions {
  /** Read-only native preset matcher; raw device controls need no catalogue. */
  matchFilaments?: FilamentMatcher;
  camera?: (resolve: (target: D.TargetRequest) => Promise<{ printer: Readonly<PrinterConfiguration>; revision: D.Revision }>) => Required<NonNullable<HttpServiceBehavior['media']>>;
  timelapses?: U1TimelapseTransport;
}
interface U1State {
  preparation?: U1PreparationSnapshot;
  device?: U1DeviceSnapshot;
  materialOperationActive?: boolean;
  submissionActive?: boolean;
  observationHub?: U1ObservationHub<U1DeviceSnapshot>;
  task?: U1PrintTask;
}
const generations = new WeakMap<ConfigurationEntry, U1State>();
const submissions = new WeakMap<HttpServiceOptions['configuration'], U1Submissions>();
const mechanicalCommand = (command: D.PrinterCommand) => ['tools.select', 'tools.park', 'extrusion.move', 'motion.home', 'motion.jog'].includes(command.type);
function deviceState(entry: ConfigurationEntry): U1State {
  let state = generations.get(entry);
  if (!state) { state = {}; generations.set(entry, state); }
  return state;
}

export function createSnapmakerService(options: SnapmakerServiceOptions): D.PrinterService {
  return createHttpPrinterService(options, 'snapmaker', 'Snapmaker', context => createSnapmakerBehavior(options, context));
}
function createSnapmakerBehavior(options: SnapmakerServiceOptions, context: HttpServiceContext): HttpServiceBehavior {
  const { http, resolve, targetFor, readFirmware } = context;
  const storage = new U1Storage(context, options.timelapses);
  const camera = options.camera?.(async target => { const { printer, entry } = await resolve(target); return { printer, revision: entry.revision }; });
  const descriptor: HttpServiceContext['descriptor'] = (...args) => {
    const result = context.descriptor(...args);
    if (camera) result.topology.cameras = [{ id: U1_CAMERA_ID, name: 'Chamber camera', role: 'chamber', toolId: null, lightId: null }];
    return result;
  };
  const matchFilaments = options.matchFilaments;
  async function readStatus(printer: PrinterConfiguration, snapshot: U1DeviceSnapshot, signal?: AbortSignal) {
    const status = await context.readStatus(printer, signal, snapshot.status, snapshot.remainingSeconds, u1PrintStage(snapshot.status));
    const active = u1ActiveToolIds(snapshot);
    status.activeToolIds = active === undefined ? unknown : known(targetFor(printer.id), active);
    if (snapshot.taskId) status.printStatus.taskId = known(targetFor(printer.id), snapshot.taskId);
    return status;
  }
  function task(printer: PrinterConfiguration, entry: ConfigurationEntry) {
    return deviceState(entry).task ??= new U1PrintTask(http, printer);
  }
  function capabilities(entry?: ConfigurationEntry): D.PrinterCapabilities {
    const result = context.capabilities();
    result.submission = supported({ formats: ['gcode'], failurePolicy: 'retry' });
    result.currentPrintPreview = supported({ mimeTypes: ['image/png', 'image/jpeg'] });
    Object.assign(result.files, u1StorageCapabilities(options.timelapses !== undefined));
    if (camera) result.cameras = [copy(u1CameraCapability)];
    result.commands = { ...result.commands, 'jobs.start': unsupported, ...u1DeviceCapabilities(entry ? deviceState(entry).device : undefined), 'files.delete': u1DeleteCapability };
    for (const topic of ['preferences', 'descriptor', 'status', 'thermal', 'actuators', 'materials', 'sensors'] as const)
      result.observations[topic] = supported({ delivery: ['poll', 'on-demand'] });
    const snapshot = entry ? deviceState(entry).device : undefined;
    result.observations.motion = !snapshot ? { kind: 'unknown', reason: 'Motion objects have not been read.' }
      : snapshot.objects.includes('toolhead') ? supported({ delivery: ['poll', 'on-demand'] }) : unsupported;
    return result;
  }
  function hub(printer: PrinterConfiguration, entry: ConfigurationEntry) {
    const state = deviceState(entry);
    if (!state.observationHub) {
      state.observationHub = new U1ObservationHub(async signal => {
        const { printer: currentPrinter } = await resolve({ ...targetFor(printer.id), expectedConfigurationRevision: entry.revision });
        const snapshot = await readU1Device(http, currentPrinter, signal);
        state.device = snapshot;
        const target = targetFor(printer.id);
        const values = u1DeviceValues(snapshot, target, entry.revision, descriptor(currentPrinter, entry, entry.cache.firmware ?? unknown), currentPrinter.printerModel);
        if (values.materials && matchFilaments) await matchU1Materials(values.materials, matchFilaments, snapshot.status);
        Object.assign(snapshot, await task(currentPrinter, entry).observe(snapshot.status, signal));
        values.status = await readStatus(currentPrinter, snapshot, signal);
        for (const [topic, value] of Object.entries(values)) Object.assign(entry.cache, { [topic]: known(target, value) });
        if (values.materials) state.preparation = u1PreparationFromDevice(snapshot.status, snapshot.commands, target, entry.revision, snapshot.receivedAtMs);
        return snapshot;
      }, () => {
        for (const [topic, value] of Object.entries(entry.cache)) Object.assign(entry.cache, { [topic]: retained(value) });
        if (state.preparation) state.preparation = { ...state.preparation, inventory: retained(state.preparation.inventory) };
      });
    }
    return state.observationHub;
  }
  const observations: D.PrinterObservations = {
    read: (request, options) => safe(async () => {
      if (!request.topics.length || request.topics.some(topic => !(topic in capabilities().observations))) fail('invalid-request', 'Invalid observation topics');
      if (request.source !== 'cache' && request.source !== 'device') fail('invalid-request', 'Select cache or device');
      const { printer, entry } = await resolve(request.target);
      const state = deviceState(entry);
      const observed: ConfigurationEntry['cache'] = {};
      if (request.source === 'device') {
        if (request.topics.some(topic => capabilities(entry).observations[topic].kind === 'unsupported')) fail('unsupported', unsupported.reason);
        await hub(printer, entry).refresh();
        if (request.topics.some(topic => capabilities(entry).observations[topic].kind !== 'supported')) fail('unsupported', unsupported.reason);
        Object.assign(observed, entry.cache);
        // Explicit reads return current values even when there is no ongoing consumer.
        const values = u1DeviceValues(state.device!, request.target, entry.revision, descriptor(printer, entry, entry.cache.firmware ?? unknown), printer.printerModel);
        if (values.materials && matchFilaments) await matchU1Materials(values.materials, matchFilaments, state.device!.status);
        values.status = await readStatus(printer, state.device!, options?.signal);
        for (const [topic, value] of Object.entries(values)) Object.assign(observed, { [topic]: known(request.target, value) });
        if (request.topics.some(topic => topic === 'materials') && !values.materials) fail('unsupported', 'U1 material information is unavailable');
        if (request.topics.some(topic => topic === 'firmware')) {
          Object.assign(observed, await readFirmware({ printer, entry }, request.target, options?.signal));
        }
      }
      const values = Object.fromEntries(request.topics.map(topic => {
        const reading = (request.source === 'device' ? observed[topic] : entry.cache[topic]) ?? unknown;
        return [topic, reading];
      })) as D.ObservationValues<typeof request.topics[number]>;
      return copy({ target: request.target, configurationRevision: entry.revision, values });
    }),
    watch: async function* (request, readOptions) {
      const { printer, entry } = await resolve(request.target);
      if (!request.topics.length || request.topics.some(topic => capabilities(entry).observations[topic]?.kind !== 'supported')) fail('unsupported', 'Observation topic unavailable');
      for await (const _update of hub(printer, entry).watch(readOptions?.signal)) {
        const values = Object.fromEntries(request.topics.map(topic => [topic, entry.cache[topic] ?? unknown])) as D.ObservationValues<typeof request.topics[number]>;
        yield { type: 'snapshot', cursor: newId<'cursor'>() as unknown as D.ObservationCursor, snapshot: { target: request.target, configurationRevision: entry.revision, values: copy(values) } };
      }
    },
  };
  let executor = submissions.get(options.configuration);
  if (!executor) {
    executor = new U1Submissions({ http,
      retainObservation: async target => {
        const { printer, entry } = await resolve(target), state = deviceState(entry);
        if (state.materialOperationActive) fail('busy', 'A tool or material operation is still running.');
        state.submissionActive = true;
        const release = hub(printer, entry).retain();
        return () => { state.submissionActive = false; release(); };
      },
      resolve: async target => { const { printer, entry } = await resolve(target); return { printer, revision: entry.revision }; },
      prepare: request => safe(async () => {
        const { printer, entry } = await resolve(request.target);
        const state = deviceState(entry);
        if (!state.preparation || request.checkRecording) await hub(printer, entry).refresh();
        const snapshot = state.device!;
        state.preparation = u1PreparationFromDevice(snapshot.status, snapshot.commands, request.target, entry.revision, snapshot.receivedAtMs);
        if (hub(printer, entry).unavailable) state.preparation.inventory = retained(state.preparation.inventory);
        return prepareU1Submission(request, state.preparation, entry.revision);
      }),
    });
    submissions.set(options.configuration, executor);
  }
  return {
    capabilities, observations, submissions: executor, files: storage.files,
    media: {
      ...camera,
      open: (request, options) => request.source.kind === 'file-preview' ? storage.open(request, options)
        : camera?.open(request, options) ?? Promise.resolve({ ok: false, error: { code: 'unsupported', message: unsupported.reason } }),
      close: ref => storage.ownsMedia(ref) ? storage.close(ref)
        : camera?.close(ref) ?? Promise.resolve({ ok: false, error: { code: 'unsupported', message: unsupported.reason } }),
    },
    readCurrentPrintPreview: (target, readOptions) => safe(async () => {
      const signal = AbortSignal.any([AbortSignal.timeout(15000), ...(readOptions?.signal ? [readOptions.signal] : [])]);
      const { printer, entry } = await resolve(target);
      const preview = await task(printer, entry).preview(target, entry.revision, signal);
      await resolve({ ...target, expectedConfigurationRevision: entry.revision });
      return preview;
    }),
    validateTask: async ({ printer, entry }, expectedTaskId) => {
      const current = await task(printer, entry).current();
      if (current?.taskId !== expectedTaskId) fail('stale-context', 'The current task changed.');
      await resolve({ ...targetFor(printer.id), expectedConfigurationRevision: entry.revision });
    },
    validateCommand: async ({ printer, entry }, command) => {
      if (command.type === 'files.delete') {
        storage.validateDeletion({ printer, entry }, command.params.target);
      } else if (!command.type.startsWith('jobs.')) {
        if (mechanicalCommand(command)) {
          const state = deviceState(entry);
          if (state.materialOperationActive || state.submissionActive) fail('busy', 'A tool, material or print submission is still running.');
          await hub(printer, entry).refresh();
        } else if (!deviceState(entry).device) await hub(printer, entry).refresh();
        u1DeviceCommand(deviceState(entry).device!, command);
      }
    },
    retainOperation: ({ printer, entry }, command) => {
      if (command?.type === 'files.delete') return () => {};
      const state = deviceState(entry);
      const materialOperation = command !== undefined && (command.type === 'materials.load' || command.type === 'materials.unload' || mechanicalCommand(command));
      if (materialOperation && state.materialOperationActive) fail('busy', 'Another individual material operation is still running');
      if (materialOperation && state.submissionActive) fail('busy', 'A print submission is still running.');
      if (materialOperation) state.materialOperationActive = true;
      const release = hub(printer, entry).retain();
      return () => { if (materialOperation) state.materialOperationActive = false; release(); };
    },
    executeCommand: async ({ printer, entry }, command) => {
      if (command.type === 'files.delete') {
        await storage.delete({ printer, entry }, command.params.target);
        return 'completed';
      }
      const state = deviceState(entry);
      if (mechanicalCommand(command)) {
        state.device = await readU1Device(http, printer);
        await resolve({ ...targetFor(printer.id), expectedConfigurationRevision: entry.revision });
        const script = u1DeviceCommand(state.device, command);
        if (command.type === 'extrusion.move' || command.type === 'motion.jog') {
          const saved = command.type === 'extrusion.move' ? 'orca_device_extrusion' : 'orca_device_jog';
          await http.post(printer, '/printer/gcode/script', { script: `SAVE_GCODE_STATE NAME=${saved}` });
          try { await http.post(printer, '/printer/gcode/script', { script }); }
          finally {
            try { await http.post(printer, '/printer/gcode/script', { script: `RESTORE_GCODE_STATE NAME=${saved}` }); }
            catch { throw new MoonrakerFailure({ code: 'device-failed', message: 'G-code state restoration was not confirmed. Check the printer before another operation.' }, true); }
          }
        } else {
          await http.post(printer, '/printer/gcode/script', { script });
          try {
            const after = await readU1Device(http, printer);
            if (command.type === 'motion.home') {
              if (!command.params.axes.every(axis => u1HomedAxes(after)?.includes(axis))) throw new Error('Unconfirmed homing state');
            } else {
              const active = u1ActiveToolIds(after), expected = command.type === 'tools.select' ? [command.params.toolId] : [];
              if (active === undefined || JSON.stringify(active) !== JSON.stringify(expected)) throw new Error('Unconfirmed physical state');
            }
            state.device = after;
          } catch {
            throw new MoonrakerFailure({ code: 'device-failed', message: 'Printer motion was acknowledged but its physical outcome is unconfirmed.' }, true);
          }
        }
        // A monitor read failure marks its readings stale without discarding the command's established evidence.
        await hub(printer, entry).refresh().catch(() => {});
        if (command.type !== 'extrusion.move' && command.type !== 'motion.jog') return 'completed';
      } else if (command.type === 'preferences.set') {
        state.device = await readU1Device(http, printer);
        for (const script of u1PreferenceScripts(state.device, command.params.changes)) await http.post(printer, '/printer/gcode/script', { script });
        state.device = await readU1Device(http, printer);
        verifyU1Preferences(state.device, command.params.changes);
      } else if (!command.type.startsWith('jobs.')) {
        await http.post(printer, '/printer/gcode/script', { script: u1DeviceCommand(state.device!, command) });
      } else {
        await http.post(printer, '/printer/gcode/script', { script: { 'jobs.pause': 'PAUSE', 'jobs.resume': 'RESUME', 'jobs.cancel': 'CANCEL_PRINT' }[command.type as 'jobs.pause' | 'jobs.resume' | 'jobs.cancel'] });
      }
    },
  };
}
