import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { BambuNative, NativeEvent } from '@orca/bambu-native';
import type { Result } from '@orca/printer-control/domain';
import type { BambuLanCandidate } from '../../shared/bambuDevices';
import type { BambuRepository } from './repository';

interface Candidate extends BambuLanCandidate { connectionName: string }
const fail = (code: 'permission-denied' | 'transport' | 'stale-context' | 'busy' | 'cancelled', message: string): Result<null> => ({ ok: false, error: { code, message } });
const ok = (): Result<null> => ({ ok: true, value: null });
/** SSDP is a candidate. Only a successful native LAN callback grants remembered access. */
export class BambuLan {
  private readonly candidates = new Map<string, Candidate>();
  private readonly expired = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly timer: ReturnType<typeof setInterval>;
  private pending: { deviceId: string; finish(result: Result<null>): void } | null = null;
  private operation: Promise<Result<null>> | null = null;
  private activeDevice: string | null = null;
  private closed = false;
  private sequence = 20000; // Orca MachineObject::START_SEQ_ID.
  constructor(private readonly native: BambuNative, private readonly repository: BambuRepository, private readonly changed: () => void,
    private readonly now = () => Date.now(), private readonly timeoutMs = 30_000) {
    this.timer = setInterval(() => this.expire(), 1000); this.timer.unref();
  }
  private queue<T>(work: () => Promise<T>) { const result = this.tail.then(work); this.tail = result.catch(() => undefined); return result; }
  private expire() {
    let changed = false;
    for (const [id, candidate] of this.candidates) if (candidate.expiresAtMs <= this.now() && !this.expired.has(id)) { this.expired.add(id); changed = true; }
    if (changed) this.changed();
  }
  async list(): Promise<readonly BambuLanCandidate[]> {
    await this.tail; this.expire();
    return [...this.candidates.values()].filter(candidate => candidate.expiresAtMs > this.now()).map(({ connectionName: _connection, ...candidate }) => candidate);
  }
  onEvent(event: NativeEvent) {
    if (this.closed) return;
    if (event.type === 'ssdp') void this.queue(() => this.announce(event.args[0])).catch(() => undefined);
    if (event.type === 'local-connect' && event.args[1] === this.pending?.deviceId) {
      const pending = this.pending;
      if (event.args[0] === 0) void this.queue(() => this.bootstrap(pending.deviceId, false)).then(() => pending.finish(ok()), () => pending.finish(fail('transport', 'LAN initialization failed.')));
      else pending.finish(event.args[2] === '5' ? fail('permission-denied', 'Incorrect access code.') : fail('transport', 'The printer connection failed.'));
    }
    if (event.type === 'printer-connected') {
      const deviceId = event.args[0].replace(/^tunnel\//, '');
      if (deviceId === this.pending?.deviceId || deviceId === this.activeDevice) void this.queue(() => this.bootstrap(deviceId, true)).catch(() => undefined);
    }
  }
  private async announce(text: string) {
    let value: Record<string, unknown>;
    try { value = JSON.parse(text); } catch { return; }
    if (!value || typeof value !== 'object' || !['lan', 'farm'].includes(String(value.connect_type))
      || typeof value.dev_id !== 'string' || !value.dev_id || typeof value.dev_name !== 'string' || typeof value.dev_ip !== 'string'
      || !isIP(value.dev_ip) || typeof value.dev_type !== 'string' || (value.connection_name != null && typeof value.connection_name !== 'string')) return;
    const id = value.dev_id; const connectionName = typeof value.connection_name === 'string' ? value.connection_name : '';
    const previous = this.candidates.get(id);
    let address = value.dev_ip;
    let connection = previous?.connectionName ?? connectionName;
    // DevManager::on_machine_alive keeps the old address for a different named connection.
    if (previous && previous.address !== address && connectionName && previous.connectionName && previous.connectionName !== connectionName) address = previous.address;
    else if (previous && previous.address !== address && connectionName && !connection) connection = connectionName;
    const candidate: Candidate = { candidateId: previous && previous.expiresAtMs > this.now() && previous.address === address ? previous.candidateId : randomUUID(), deviceId: id,
      name: value.dev_name, model: value.dev_type, address, connectionName: connection, expiresAtMs: this.now() + 30_000 };
    this.candidates.set(id, candidate); this.expired.delete(id);
    const saved = (await this.repository.read()).lan.find(record => record.deviceId === id);
    if (saved) {
      const updateIp = saved.ip === value.dev_ip || !connectionName || !previous?.connectionName || previous.connectionName === connectionName;
      const ip = updateIp ? value.dev_ip : saved.ip;
      const name = value.dev_name; const model = value.dev_type;
      if (saved.name !== name || saved.model !== model || saved.ip !== ip) {
        await this.repository.update(state => ({ ...state, lan: state.lan.map(record => record.deviceId !== id ? record : { ...record, name, model, ip,
          revision: saved.ip === ip ? record.revision : randomUUID() }) }));
      }
    }
    this.changed();
  }
  private async bootstrap(deviceId: string, connected: boolean) {
    const send = (section: string, command: string, qos = 0, fields = {}) => this.native.sendMessageToPrinter(deviceId,
      JSON.stringify({ [section]: { sequence_id: String(this.sequence++), command, ...fields } }), qos, 0);
    await send('pushing', 'pushall', 0, { version: 1, push_target: 1 });
    await send('info', 'get_version', 1);
    if (connected) { await send('system', 'get_access_code'); await this.native.installDeviceCertificate(deviceId, true); }
  }
  private mutate(work: () => Promise<Result<null>>): Promise<Result<null>> {
    if (this.operation || this.closed) return Promise.resolve(fail('busy', 'Another printer operation is in progress.'));
    const operation = work(); this.operation = operation;
    return operation.finally(() => { if (this.operation === operation) this.operation = null; });
  }
  authorize(candidateId: string, code: string) { return this.mutate(() => this.authorizeNow(candidateId, code)); }
  private async authorizeNow(candidateId: string, code: string): Promise<Result<null>> {
    if (this.pending) return fail('busy', 'Another printer connection is in progress.');
    await this.tail; this.expire();
    const candidate = [...this.candidates.values()].find(candidate => candidate.candidateId === candidateId && candidate.expiresAtMs > this.now());
    if (!candidate) return fail('stale-context', 'This printer announcement has expired. Discover it again.');
    const saved = (await this.repository.read()).lan.find(record => record.deviceId === candidate.deviceId);
    if (this.closed) return fail('cancelled', 'The application is closing.');
    const accessCode = code || saved?.accessCode || '';
    if (!/^[A-Za-z0-9]{1,12}$/.test(accessCode)) return fail('permission-denied', 'Enter the access code shown on the printer.');
    let finish!: (result: Result<null>) => void;
    const completed = new Promise<Result<null>>(resolve => { finish = resolve; });
    this.pending = { deviceId: candidate.deviceId, finish };
    const timeout = setTimeout(() => finish(fail('transport', 'The printer connection timed out.')), this.timeoutMs);
    try {
      if (this.activeDevice) { await this.native.disconnectPrinter(); this.activeDevice = null; }
      if (await this.native.getSelectedMachine()) await this.native.setSelectedMachine('');
      if (await this.native.connectPrinter(candidate.deviceId, candidate.address, 'bblp', accessCode, true) !== 0) finish(fail('transport', 'The printer connection could not be started.'));
      const result = await completed;
      if (!result.ok) { await this.native.disconnectPrinter(); return result; }
      await this.tail;
      if (this.closed) return fail('cancelled', 'The printer connection was cancelled.');
      const current = this.candidates.get(candidate.deviceId) ?? candidate;
      await this.repository.update(state => ({ ...state, lan: [...state.lan.filter(record => record.deviceId !== candidate.deviceId), {
        deviceId: candidate.deviceId, name: current.name, model: current.model, ip: current.address, accessCode,
        revision: randomUUID(),
      }] }));
      this.activeDevice = candidate.deviceId; this.changed(); return ok();
    } catch { await this.native.disconnectPrinter().catch(() => undefined); this.activeDevice = null; return fail('transport', 'The LAN connection could not be saved.'); }
    finally { clearTimeout(timeout); this.pending = null; }
  }
  forget(deviceId: string, expectedRevision?: string) { return this.mutate(() => this.forgetNow(deviceId, expectedRevision)); }
  private async forgetNow(deviceId: string, expectedRevision?: string): Promise<Result<null>> {
    if (this.pending) return fail('busy', 'Wait for the current printer connection.');
    await this.tail;
    const record = (await this.repository.read()).lan.find(record => record.deviceId === deviceId);
    if (!record || (expectedRevision !== undefined && record.revision !== expectedRevision)) return fail('stale-context', 'This LAN connection has changed.');
    const stale = new Error('LAN connection changed');
    try {
      if (this.activeDevice === deviceId) { await this.native.disconnectPrinter(); this.activeDevice = null; }
      await this.repository.update(state => {
        const current = state.lan.find(record => record.deviceId === deviceId);
        if (!current || (expectedRevision !== undefined && current.revision !== expectedRevision)) throw stale;
        return { ...state, lan: state.lan.filter(record => record.deviceId !== deviceId) };
      });
      this.changed(); return ok();
    } catch (error) { return error === stale ? fail('stale-context', 'This LAN connection has changed.') : fail('transport', 'The LAN connection could not be forgotten.'); }
  }
  async close() { this.closed = true; clearInterval(this.timer); this.pending?.finish(fail('cancelled', 'The application is closing.')); await this.operation?.catch(() => undefined); await this.tail; }
}
