import { BambuOperations } from './operations';
import type { BambuControlRequest } from '../../shared/bambuControl';
import { BambuMonitor } from './monitor';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadBambuNative, type BambuNative, type NativeEvent } from '@orca/bambu-native';
import type { AccountState } from '@orca/service-provider';
import { bambuRegionChoices, unavailableBambuAccount, type BambuChange, type BambuHostConfig, type BambuRead, type BambuReadResults } from '../../shared/bambu';
import { BambuAccount, bambuCountry } from './account';
import type { BambuHostRequest } from '../../shared/bambuHost';
import { BambuLan } from './lan';
import { BambuDevices } from './devices';
import { BambuRepository } from './repository';

/** Native agent lifecycle and local state are application-owned, never window-owned. */
export class BambuRuntime {
  private native: BambuNative | null = null;
  private lan: BambuLan | null = null;
  private monitor: BambuMonitor | null = null;
  private operations: BambuOperations | null = null;
  private account: BambuAccount | null = null;
  private state: AccountState = { status: 'restoring', error: null };
  private ready: Promise<void>;
  private readonly repository: BambuRepository;
  private readonly devices: BambuDevices;
  constructor(private readonly config: BambuHostConfig, private readonly publish: (change: BambuChange) => void,
    private readonly load: typeof loadBambuNative = loadBambuNative) {
    this.repository = new BambuRepository(config.directory);
    this.devices = new BambuDevices(this.repository, () => { publish('printers'); void this.monitor?.reconcile().catch(() => undefined); });
    this.ready = this.initialize();
  }
  private async initialize() {
    try {
      const settings = await this.repository.read();
      const directory = join(this.config.directory, 'plugin');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const agent = this.load(this.config.addonPath, this.config.pluginPath, event => this.onEvent(event));
      this.native = agent;
      this.lan = new BambuLan(agent, this.repository, () => this.publish('printers'));
      const ok = async (result: Promise<number>) => { if (await result !== 0) throw new Error('Bambu initialization failed'); };
      if (await agent.getVersion() !== '02.08.01.99') throw new Error('Unexpected Bambu plugin version');
      await ok(agent.createAgent(directory));
      await ok(agent.setConfigDirectory(directory));
      await ok(agent.initLog());
      await ok(agent.setCertificate(this.config.certificateDirectory, 'slicer_base64.cer'));
      await ok(agent.installCallbacks());
      const country = bambuCountry(settings.region);
      await ok(agent.setCountryCode(country));
      // BBLCloudServiceAgent::start installs these headers before the native start call.
      await ok(agent.setExtraHttpHeaders({
        'X-BBL-Client-Type': 'slicer', 'X-BBL-Client-Name': 'BambuStudio',
        'X-BBL-Client-Version': '02.08.01.55', 'X-BBL-OS-Type': this.config.osType,
        'X-BBL-OS-Version': this.config.osVersion, 'X-BBL-Device-ID': settings.clientId, 'X-BBL-Language': 'en-US',
      }));
      await ok(agent.start());
      await ok(agent.trackEnable(false)); await ok(agent.trackRemoveFiles());
      await ok(agent.installDiscoveryCallbacks());
      await agent.startDiscovery(true, false);
      this.monitor = new BambuMonitor(agent, this.devices, this.repository, () => this.lan!.release(), () => this.publish('control'));
      this.operations = new BambuOperations(this.monitor, () => this.publish('control'));
      this.account = new BambuAccount(agent, this.repository, this.publish, this.devices);
      await this.account.restore();
    } catch {
      await this.monitor?.close(); this.monitor = null;
      await this.lan?.close(); this.lan = null; this.account = null; this.state = unavailableBambuAccount();
      await this.native?.close().catch(() => undefined); this.native = null;
    }
    this.publish('account');
  }
  private onEvent(event: NativeEvent) {
    // Only invalidations leave the utility; native messages may contain credentials.
    this.account?.onEvent(event);
    this.lan?.onEvent(event);
    this.monitor?.onEvent(event);
    void this.operations?.onEvent(event).catch(() => undefined);
  }
  read<K extends BambuRead>(kind: K): Promise<BambuReadResults[K]>;
  async read(kind: BambuRead): Promise<BambuReadResults[BambuRead]> {
    await this.ready;
    if (kind === 'account.state') return structuredClone(this.account?.state ?? this.state);
    if (kind === 'account.settings') {
      const { region } = await this.repository.read();
      return [{ key: 'region', label: 'Region', value: region, choices: bambuRegionChoices }];
    }
    if (kind === 'printers.candidates') return this.lan ? { ok: true, value: await this.lan.list() } : { ok: false, error: { code: 'unsupported', message: 'LAN discovery is unavailable.' } };
    return { ok: true, value: await this.devices.list() };
  }
  async host(request: BambuHostRequest) {
    await this.ready;
    if (request.method === 'lan.authorize' || request.method === 'lan.forget') {
      if (!this.lan || !this.monitor) throw new Error('Unavailable');
      const lan = this.lan;
      return this.monitor.suspend(() => request.method === 'lan.authorize' ? lan.authorize(request.input.candidateId, request.input.accessCode) : lan.forget(request.input.deviceId, request.input.expectedRevision));
    }
    if (!this.account) throw new Error('Bambu networking is unavailable.');
    return this.account.handle(request);
  }
  async control(request: BambuControlRequest) {
    await this.ready;
    if (!this.monitor || !this.operations) return request.method === 'submit' ? { kind: 'rejected' as const, error: { code: 'transport' as const, message: 'Bambu networking is unavailable.' } } : { ok: false as const, error: { code: 'transport' as const, message: 'Bambu networking is unavailable.' } };
    switch (request.method) {
      case 'evaluate': return this.operations.evaluate(request.input.target, request.input.command);
      case 'submit': return this.operations.submit(request.input);
      case 'operation': return this.operations.get(request.input);
      case 'find': return this.operations.find(request.input);
      case 'describe': return this.monitor.describe(request.input);
      case 'read': return this.monitor.read(request.input);
      case 'observe': return this.monitor.start(request.input.target, request.input.token);
      case 'release': return this.monitor.stop(request.input.token);
    }
  }
  async close() { await this.ready; this.operations?.close(); await this.monitor?.close(); await this.lan?.close(); await this.account?.close(); await this.native?.close(); this.native = null; }
}
