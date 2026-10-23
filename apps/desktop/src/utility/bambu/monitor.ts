import { randomUUID } from 'node:crypto';
import type { BambuNative, NativeEvent } from '@orca/bambu-native';
import type * as D from '@orca/printer-control/domain';
import type { BambuDevices } from './devices';
import type { BambuRepository } from './repository';
import { savedBambuPrinter } from '../../shared/bambuPrinters';
import { BambuTelemetry } from './telemetry';

type Entry = { deviceId: string; printer: D.SavedPrinter; route: D.PrinterRoute; target: D.PrinterTarget; telemetry: BambuTelemetry };
const error = (code: D.ErrorCode, message: string) => ({ ok: false as const, error: { code, message } });
/** One ordinary native selection per Electron instance. Tokens only bind IPC stream cleanup. */
export class BambuMonitor {
  private readonly cache = new Map<string, Entry>();
  private active: Entry | null = null;
  private readonly tokens = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private sequence = 30000;
  private lastResync = -Infinity;
  private lastFresh = false;
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly received = new Set<() => void>();
  constructor(private readonly native: BambuNative, private readonly devices: Pick<BambuDevices, 'list'>,
    private readonly repository: Pick<BambuRepository, 'read'>, private readonly releaseLan: () => Promise<void>,
    private readonly changed: () => void, private readonly now = () => Date.now(), private readonly readTimeoutMs = 10_000) {
    this.timer = setInterval(() => {
      const fresh = this.active ? this.active.telemetry.project(this.active.target, this.active.printer.identity).fresh : false;
      if (fresh !== this.lastFresh) { this.lastFresh = fresh; this.changed(); }
    }, 1000); this.timer.unref();
  }
  private queue<T>(work: () => Promise<T>) { const result = this.tail.then(work); this.tail = result.catch(() => undefined); return result; }
  private async resolve(target: D.PrinterTarget): Promise<Entry | null> {
    const device = (await this.devices.list()).find(device => `bambu:${encodeURIComponent(device.deviceId)}` === target.printerId);
    if (!device) return null;
    const printer = savedBambuPrinter(device), route = printer.routes.find(route => route.id === target.routeId);
    if (!route) return null;
    const key = `${route.id}@${route.configurationRevision}`;
    let entry = this.cache.get(key);
    if (!entry) { entry = { deviceId: device.deviceId, printer, route, target, telemetry: new BambuTelemetry(this.now) }; this.cache.set(key, entry); }
    entry.printer = printer; entry.route = route;
    return entry;
  }
  async describe(target: D.PrinterTarget): Promise<D.Result<D.PrinterDescription>> {
    const entry = await this.resolve(target);
    if (!entry) return error('invalid-target', 'This Bambu route is no longer available.');
    return { ok: true, value: { target, configurationRevision: entry.route.configurationRevision, capabilities: entry.route.capabilities,
      descriptor: entry.telemetry.snapshot(target, entry.printer.identity, entry.route.configurationRevision, ['descriptor']).values.descriptor } };
  }
  private async disconnect() {
    const previous = this.active; this.active = null; this.lastFresh = false;
    if (previous) {
      previous.telemetry.invalidate(); this.received.forEach(wake => wake()); this.changed();
      if (previous.route.configuration.channel === 'lan') await this.native.disconnectPrinter();
      else { await this.native.setSelectedMachine(''); await this.native.stopSubscribe('app'); }
    }
  }
  private async connect(entry: Entry) {
    await this.disconnect(); await this.releaseLan();
    entry.telemetry.invalidate(); this.active = entry; this.lastResync = -Infinity; this.changed();
    try {
      if (entry.route.configuration.channel === 'cloud') {
        if (await this.native.setSelectedMachine(entry.deviceId) !== 0 || await this.native.startSubscribe('app') !== 0) throw new Error('Cloud subscribe failed');
        await this.bootstrap(entry);
      } else {
        const saved = (await this.repository.read()).lan.find(record => record.deviceId === entry.deviceId && record.revision === entry.route.configurationRevision);
        if (!saved || await this.native.connectPrinter(saved.deviceId, saved.ip, 'bblp', saved.accessCode, true) !== 0) throw new Error('LAN connect failed');
      }
    } catch { await this.disconnect().catch(() => undefined); throw new Error('Printer monitoring is unavailable.'); }
  }
  private preferred(entry: Entry) { return !entry.printer.routes.some(route => route.configuration.channel === 'cloud') || entry.route.configuration.channel === 'cloud'; }
  start(target: D.PrinterTarget, token: string): Promise<D.Result<null>> {
    return this.queue(async () => {
      if (this.closed) return error('cancelled', 'The application is closing.');
      const entry = await this.resolve(target);
      if (!entry) return error('invalid-target', 'This Bambu route is no longer available.');
      if (!this.preferred(entry)) return error('precondition-failed', 'Use the available Cloud route for this printer.');
      if (this.active !== entry) { this.tokens.clear(); try { await this.connect(entry); } catch { return error('transport', 'Printer monitoring could not be started.'); } }
      this.tokens.add(token); return { ok: true, value: null };
    });
  }
  stop(token: string): Promise<D.Result<null>> {
    return this.queue(async () => {
      if (this.tokens.delete(token) && !this.tokens.size) await this.disconnect();
      return { ok: true, value: null };
    });
  }
  async read<K extends D.StateTopic>(request: D.ObservationRequest<K> & { source: 'cache' | 'device' }): Promise<D.Result<D.PrinterSnapshot<K>>> {
    if (request.topics.includes('cameras' as K)) return error('unsupported', 'Camera monitoring is not included.');
    const entry = await this.resolve(request.target);
    if (!entry) return error('invalid-target', 'This Bambu route is no longer available.');
    let snapshot: D.PrinterSnapshot<K> | undefined;
    if (request.source === 'device') {
      const token = randomUUID();
      const setup = await this.queue(async () => {
        if (this.closed) return error('cancelled', 'The application is closing.');
        if (!this.preferred(entry)) return error('precondition-failed', 'Use the available Cloud route for this printer.');
        if (this.active && this.active !== entry) return error('busy', 'Another printer is being monitored.');
        if (!this.active) await this.connect(entry);
        this.tokens.add(token);
        return { ok: true as const, value: null };
      }).catch(() => error('transport', 'The printer could not be reached.'));
      if (!setup.ok) return setup;
      const generation = entry.telemetry.generation;
      const succeeded = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => finish(false), this.readTimeoutMs);
        const wake = () => {
          if (this.active !== entry) finish(false);
          else if (entry.telemetry.generation > generation && entry.telemetry.project(entry.target, entry.printer.identity).fresh) {
            snapshot = entry.telemetry.snapshot(entry.target, entry.printer.identity, entry.route.configurationRevision, request.topics); finish(true);
          }
        };
        const finish = (value: boolean) => { clearTimeout(timer); this.received.delete(wake); resolve(value); };
        this.received.add(wake);
        void this.bootstrap(entry).catch(() => finish(false));
      });
      await this.stop(token);
      if (!succeeded) return error('offline', 'The printer did not return current status.');
    }
    return { ok: true, value: snapshot ?? entry.telemetry.snapshot(entry.target, entry.printer.identity, entry.route.configurationRevision, request.topics) };
  }
  private async bootstrap(entry: Entry) {
    if (this.active !== entry) return;
    const send = entry.route.configuration.channel === 'cloud' ? this.native.sendMessage.bind(this.native) : this.native.sendMessageToPrinter.bind(this.native);
    for (const [section, command, fields] of [['pushing', 'pushall', { version: 1, push_target: 1 }], ['info', 'get_version', {}]] as const) {
      if (this.active !== entry) return;
      if (await send(entry.deviceId, JSON.stringify({ [section]: { sequence_id: String(this.sequence++), command, ...fields } }), section === 'info' ? 1 : 0, 0) !== 0) throw new Error('Status request failed');
    }
  }
  onEvent(event: NativeEvent) {
    const entry = this.active; if (!entry || this.closed) return;
    const cloud = entry.route.configuration.channel === 'cloud';
    if ((event.type === 'message' && cloud || event.type === 'local-message' && !cloud) && event.args[0] === entry.deviceId) {
      const result = entry.telemetry.accept(event.args[1]);
      if (result === 'updated') { this.lastFresh = entry.telemetry.project(entry.target, entry.printer.identity).fresh; this.changed(); this.received.forEach(wake => wake()); }
      if (result === 'resync' && this.now() - this.lastResync > 2000) { this.lastResync = this.now(); void this.queue(() => this.bootstrap(entry)).catch(() => undefined); }
    } else if (event.type === 'printer-connected' && event.args[0].replace(/^tunnel\//, '') === entry.deviceId
      || event.type === 'local-connect' && !cloud && event.args[1] === entry.deviceId && event.args[0] === 0
      || event.type === 'server-connected' && cloud && event.args[0] === 0) {
      entry.telemetry.invalidate(); this.changed(); void this.queue(() => this.bootstrap(entry)).catch(() => undefined);
    } else if (event.type === 'local-connect' && !cloud && event.args[1] === entry.deviceId && event.args[0] !== 0
      || cloud && (event.type === 'server-error' || event.type === 'subscribe-failure' && event.args[0] === entry.deviceId || event.type === 'server-connected' && event.args[0] !== 0)) {
      entry.telemetry.invalidate(); this.lastFresh = false; this.changed(); this.received.forEach(wake => wake());
    }
  }
  /** Catalogue removal/revision invalidates the old route; transient transport errors never select LAN. */
  reconcile() {
    return this.queue(async () => {
      const active = this.active; if (!active) return;
      const current = await this.resolve(active.target);
      if (current !== active || !this.preferred(active)) { this.tokens.clear(); await this.disconnect(); }
    });
  }
  async suspend<T>(work: () => Promise<T>): Promise<T> {
    return this.queue(async () => {
      const previous = this.active; await this.disconnect();
      try { return await work(); }
      finally { if (previous && this.tokens.size) { const current = await this.resolve(previous.target); if (current && this.preferred(current)) await this.connect(current).catch(() => undefined); } }
    });
  }
  async close() { this.closed = true; clearInterval(this.timer); await this.queue(async () => { this.tokens.clear(); await this.disconnect(); }); }
}
