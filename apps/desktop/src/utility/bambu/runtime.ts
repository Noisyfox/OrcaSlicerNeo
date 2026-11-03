import { BambuStorageImages } from './storageImages';
import { BambuStorageCommands } from './storageCommands';
import { DownloadExecutor } from '../downloadExecutor';
import type { DownloadProgress } from '@orca/printer-control/downloads';
import { BambuPrintSubmissions } from './printSubmission';
import type * as D from '@orca/printer-control/domain';
import { BambuStorageFiles } from './storageFiles';
import { BambuStorageSessions, storageNative } from './storageSessions';
import { BambuMedia } from './media';
import type { BambuMediaRequest, BambuMediaAttachment } from '../../shared/bambuMedia';
import type { CameraPort } from './mediaChannel';
import { readCurrentPrintPreview } from './preview';
import { BambuOperations } from './operations';
import { BambuObjectSkipping } from './objectSkipping';
import type { BambuControlRequest } from '../../shared/bambuControl';
import { BambuMonitor } from './monitor';
import { BambuDeviceAccess } from './deviceAccess';
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
  private readonly downloads: DownloadExecutor;
  private native: BambuNative | null = null;
  private lan: BambuLan | null = null;
  private access: BambuDeviceAccess | null = null;
  private monitor: BambuMonitor | null = null;
  private media: BambuMedia | null = null;
  private operations: BambuOperations | null = null;
  private objectSkipping: BambuObjectSkipping | null = null;
  private submissions: BambuPrintSubmissions | null = null;
  private storageSessions: BambuStorageSessions | null = null;
  private storageImages: BambuStorageImages | null = null;
  private storageFiles: BambuStorageFiles | null = null;
  private storageReads = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private cancelledStorageReads = new Set<string>();
  private closing = false;
  private account: BambuAccount | null = null;
  private state: AccountState = { status: 'restoring', error: null };
  private ready: Promise<void>;
  private readonly repository: BambuRepository;
  private readonly devices: BambuDevices;
  constructor(private readonly config: BambuHostConfig, private readonly publish: (change: BambuChange) => void,
    private readonly load: typeof loadBambuNative = loadBambuNative, private readonly storageIo = storageNative, progress: (id: string, value: DownloadProgress) => void = () => {}) {
    this.downloads = new DownloadExecutor((request, options) => this.storageFiles ? this.storageFiles.download(request, options) : Promise.resolve({ ok: false, error: { code: 'transport', message: 'Storage is unavailable.' } }), 4 * 1024 * 1024, progress);
    this.repository = new BambuRepository(config.directory);
    this.devices = new BambuDevices(this.repository, () => { publish('printers'); void this.access?.reconcile().catch(() => undefined); void this.media?.reconcile().catch(() => undefined); void this.objectSkipping?.reconcileContext().catch(() => undefined); void this.storageSessions?.reconcile().catch(() => undefined); });
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
      this.access = new BambuDeviceAccess(agent, this.devices, this.repository, () => this.lan!.release(), () => this.publish('control'));
      this.objectSkipping = new BambuObjectSkipping(this.config, agent, this.access, this.devices, this.repository, () => this.publish('control'));
      this.monitor = new BambuMonitor(this.access, this.objectSkipping);
      this.media = new BambuMedia(this.config, agent, this.access, this.devices, this.repository, () => this.publish('media'));
      this.storageSessions = new BambuStorageSessions(this.config, agent, this.devices, this.repository, this.storageIo);
      this.storageFiles = new BambuStorageFiles(target => this.storageSessions!.resolve(target));
      this.storageImages = new BambuStorageImages(this.storageFiles);
      this.submissions = new BambuPrintSubmissions(agent, this.access, this.devices, this.repository, join(this.config.directory, 'submissions'), () => this.publish('control'));
      this.operations = new BambuOperations(this.monitor, () => this.publish('control'), undefined, undefined, new BambuStorageCommands(this.storageFiles, () => this.publish('control')));
      this.account = new BambuAccount(agent, this.repository, this.publish, this.devices);
      await this.account.restore();
    } catch {
      await this.storageImages?.close(); this.storageImages = null;
      await this.storageSessions?.close(); this.storageSessions = null; this.storageFiles = null;
      await this.objectSkipping?.close(); this.objectSkipping = null;
      await this.media?.close(); this.media = null;
      await this.access?.close(); this.access = null; this.monitor = null;
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
    void this.submissions?.onEvent(event).catch(() => undefined);
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
    if (request.method === 'download.initialize') return this.downloads.initialize(request.input.root, request.input.parentPid);
    if (request.method === 'download.run') return this.downloads.run(request.input.id, request.input.file, request.input.destination);
    if (request.method === 'download.cancel') { this.downloads.cancel(request.input.id); return null; }
    if (request.method === 'lan.authorize' || request.method === 'lan.forget') {
      if (!this.lan || !this.access) throw new Error('Unavailable');
      const lan = this.lan;
      return this.access.suspend(() => request.method === 'lan.authorize' ? lan.authorize(request.input.candidateId, request.input.accessCode) : lan.forget(request.input.deviceId, request.input.expectedRevision));
    }
    if (!this.account) throw new Error('Bambu networking is unavailable.');
    return this.account.handle(request);
  }
  async control(request: BambuControlRequest) {
    await this.ready;
    if (!this.monitor || !this.operations) return request.method === 'submit' ? { kind: 'rejected' as const, error: { code: 'transport' as const, message: 'Bambu networking is unavailable.' } } : { ok: false as const, error: { code: 'transport' as const, message: 'Bambu networking is unavailable.' } };
    switch (request.method) {
      case 'storage.storages': return this.storageRead(request.input.readId, signal => this.storageFiles!.listStorages(request.input.target, { signal }));
      case 'storage.list': return this.storageRead(request.input.readId, signal => this.storageFiles!.list(request.input.request, { signal }));
      case 'storage.previews': return this.storageRead(request.input.readId, () => this.storageFiles!.listPreviews(request.input.file));
      case 'storage.stat': return this.storageRead(request.input.readId, signal => this.storageFiles!.stat(request.input.file, { signal }));
      case 'storage.cancel': {
        this.cancelledStorageReads.add(request.input.readId); this.storageReads.get(request.input.readId)?.controller.abort();
        while (this.cancelledStorageReads.size > 128) this.cancelledStorageReads.delete(this.cancelledStorageReads.values().next().value!);
        return { ok: true as const, value: null };
      }
      case 'objectMap': return this.objectSkipping!.readPickingMap(request.input.contextRef, request.input.readId);
      case 'cancelObjectRead': this.objectSkipping?.cancelRead(request.input.readId); return { ok: true as const, value: null };
      case 'print.prepare': return this.submissions!.prepare(request.input);
      case 'print.begin': return this.submissions!.begin(request.input);
      case 'print.chunk': return this.submissions!.chunk(request.input);
      case 'print.commit': return this.submissions!.commit(request.input);
      case 'print.get': return this.submissions!.get(request.input);
      case 'print.cancel': return this.submissions!.cancel(request.input);
      case 'preview': return readCurrentPrintPreview(this.access!, this.native!, request.input);
      case 'evaluate': return this.operations.evaluate(request.input.target, request.input.command);
      case 'submit': return this.operations.submit(request.input);
      case 'operation': return this.operations.get(request.input);
      case 'find': return this.operations.find(request.input);
      case 'describe': return this.monitor.describe(request.input);
      case 'read': return this.monitor.read(request.input, request.input.readId);
      case 'observe': return this.monitor.start(request.input.target, request.input.token);
      case 'release': return this.monitor.stop(request.input.token);
    }
  }
  private async storageRead<T>(readId: string, read: (signal: AbortSignal) => Promise<D.Result<T>>): Promise<D.Result<T>> {
    if (this.closing || this.cancelledStorageReads.has(readId)) return { ok: false, error: { code: 'cancelled', message: 'Storage reading was cancelled.' } };
    if (this.storageReads.has(readId) || this.storageReads.size >= 8) return { ok: false, error: { code: 'busy', message: 'Wait for another storage request to finish.' } };
    let finish!: () => void;
    const job = { controller: new AbortController(), done: new Promise<void>(resolve => { finish = resolve; }) };
    this.storageReads.set(readId, job);
    try { return await read(job.controller.signal); }
    finally { this.storageReads.delete(readId); finish(); }
  }
  async mediaCall(owner: string, request: BambuMediaRequest) {
    await this.ready;
    if (request.method === 'cancelOpen') { await Promise.all([this.storageImages?.call(owner, request), this.media?.call(owner, request)]); return { ok: true as const, value: null }; }
    if (this.storageImages && (request.method === 'open' ? request.input.source.kind === 'file-preview' : this.storageImages.owns(request.input))) return this.storageImages.call(owner, request);
    return this.media ? this.media.call(owner, request) : { ok: false as const, error: { code: 'transport' as const, message: 'Camera unavailable.' } };
  }
  async mediaAttach(owner: string, request: BambuMediaAttachment, port: CameraPort) {
    await this.ready;
    if (this.media) this.media.attach(owner, request, port); else port.close();
  }
  async mediaCloseOwner(owner: string) { await this.ready; await this.storageImages?.closeOwner(owner); await this.media?.closeOwner(owner); }
  async close() { await this.ready; this.closing = true;
    for (const read of this.storageReads.values()) read.controller.abort();
    let downloadFailure: unknown;
    try { await this.downloads.close(); } catch (error) { downloadFailure = error; }
    await this.storageImages?.close();
    await this.storageSessions?.close(); await Promise.all([...this.storageReads.values()].map(read => read.done));
    await this.operations?.close(); this.monitor?.close(); await this.submissions?.close(); await this.objectSkipping?.close(); await this.media?.close(); await this.access?.close(); await this.lan?.close(); await this.account?.close(); await this.native?.close(); this.native = null; if (downloadFailure) throw downloadFailure; }
}
