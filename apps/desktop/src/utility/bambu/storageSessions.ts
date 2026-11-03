/** Credential and native-reader lifetime binding. Independent of the selected MQTT monitor. */
import { dirname, join } from 'node:path';
import { discoverBambuStorage, listBambuStorageFiles, readBambuStorageFile, deleteBambuStorageFile, readBambuStorageResource,
  type BambuNative, type BambuStorageDownload } from '@orca/bambu-native';
import type * as D from '@orca/printer-control/domain';
import type { BambuDevices } from './devices';
import type { BambuRepository } from './repository';
import type { BambuHostConfig } from '../../shared/bambu';
import { savedBambuPrinter } from '../../shared/bambuPrinters';
import { StorageHostError, type BambuStorageSource } from './storageFiles';

export const storageNative = { discover: discoverBambuStorage, list: listBambuStorageFiles,
  download: readBambuStorageFile, remove: deleteBambuStorageFile, resource: readBambuStorageResource };
const failure = (code: D.ErrorCode, message: string) => ({ ok: false as const, error: { code, message } });

export class BambuStorageSessions {
  private readonly shutdown = new AbortController();
  private readonly active = new Map<Promise<void>, { target: D.PrinterTarget; revision: string; controller: AbortController }>();
  constructor(private readonly config: BambuHostConfig,
    private readonly native: Pick<BambuNative, 'installDeviceCertificate'>,
    private readonly devices: Pick<BambuDevices, 'list'>, private readonly repository: Pick<BambuRepository, 'read'>,
    private readonly io = storageNative) {}

  private async identity(target: D.PrinterTarget) {
    if (this.shutdown.signal.aborted) return failure('cancelled', 'Storage access is closing.');
    const device = (await this.devices.list()).find(device => `bambu:${encodeURIComponent(device.deviceId)}` === target.printerId);
    if (!device) return failure('invalid-target', 'This printer is no longer available.');
    const route = savedBambuPrinter(device).routes.find(route => route.id === target.routeId);
    if (!route) return failure('invalid-target', 'This printer route is no longer available.');
    const record = (await this.repository.read()).lan.find(record => record.deviceId === device.deviceId &&
      record.revision === device.routes.find(route => route.channel === 'lan')?.revision);
    if (!record?.ip || !record.accessCode) return failure('authentication-required', 'Authorize LAN access to browse this printer’s storage.');
    return { ok: true as const, value: { deviceId: device.deviceId, revision: route.configurationRevision, record } };
  }

  private begin(target: D.PrinterTarget, revision: string, signal?: AbortSignal) {
    if (this.shutdown.signal.aborted || signal?.aborted) throw new StorageHostError({ code: 'cancelled', message: 'Storage reading was cancelled.' });
    if (this.active.size >= 8) throw new StorageHostError({ code: 'busy', message: 'Wait for another storage request to finish.' });
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; }), controller = new AbortController();
    this.active.set(done, { target, revision, controller });
    return { signal: AbortSignal.any([controller.signal, this.shutdown.signal, ...signal ? [signal] : []]),
      release: () => { this.active.delete(done); finish(); } };
  }

  async resolve(target: D.PrinterTarget): Promise<D.Result<BambuStorageSource>> {
    try { return await this.resolveSource(target); }
    catch { return failure('transport', 'Printer storage access could not be prepared.'); }
  }
  private async resolveSource(target: D.PrinterTarget): Promise<D.Result<BambuStorageSource>> {
    target = { printerId: target.printerId, routeId: target.routeId };
    const identity = await this.identity(target); if (!identity.ok) return identity;
    const revision = identity.value.revision;
    const sourcePath = join(dirname(this.config.pluginPath), process.platform === 'win32' ? 'BambuSource.dll'
      : process.platform === 'darwin' ? 'libBambuSource.dylib' : 'libBambuSource.so');
    const authorize = async (signal: AbortSignal) => {
      const current = await this.identity(target); if (!current.ok) throw new StorageHostError(current.error);
      if (current.value.revision !== revision) throw new StorageHostError({ code: 'stale-context', message: 'The printer configuration changed. Refresh storage.' });
      if (signal.aborted) throw new StorageHostError({ code: 'cancelled', message: 'Storage reading was cancelled.' });
      await this.native.installDeviceCertificate(current.value.deviceId, true);
      const checked = await this.identity(target);
      if (!checked.ok) throw new StorageHostError(checked.error);
      if (checked.value.revision !== revision) throw new StorageHostError({ code: 'stale-context', message: 'The printer configuration changed. Refresh storage.' });
      if (signal.aborted) throw new StorageHostError({ code: 'cancelled', message: 'Storage reading was cancelled.' });
      const query = new URLSearchParams({ port: '6000', user: 'bblp', passwd: current.value.record.accessCode, device: current.value.deviceId });
      return `bambu:///local/${current.value.record.ip}?${query}`;
    };
    // Provisional host limits; physical slow-link qualification is separate from fixture coverage.
    const options = (signal: AbortSignal) => ({ signal, connectTimeoutMs: 20_000, inactivityTimeoutMs: 30_000, requestTimeoutMs: 30_000 });
    const query = async <T>(signal: AbortSignal | undefined, work: (url: string, opts: ReturnType<typeof options>) => Promise<T>): Promise<T> => {
      const job = this.begin(target, revision, signal);
      try { return await work(await authorize(job.signal), options(job.signal)); }
      finally { job.release(); }
    };
    return { ok: true, value: {
      configurationRevision: revision,
      discover: signal => query(signal, (url, opts) => this.io.discover(this.config.addonPath, sourcePath, url, opts)),
      list: (storage, collection, signal) => query(signal, (url, opts) => this.io.list(this.config.addonPath, sourcePath, url, { storage, collection, maxEntries: 20_000 }, opts)),
      resource: (path, resource, maxBytes, signal) => query(signal, (url, opts) => this.io.resource(this.config.addonPath, sourcePath, url, { path, resource, maxBytes }, { ...opts, signal: AbortSignal.any([opts.signal, AbortSignal.timeout(opts.requestTimeoutMs)]) })),
      remove: (file, signal) => query(signal, (url, opts) => this.io.remove(this.config.addonPath, sourcePath, url, file, opts)),
      download: async (file, signal) => {
        const job = this.begin(target, revision, signal);
        try {
          const value = await this.io.download(this.config.addonPath, sourcePath, await authorize(job.signal), file, options(job.signal));
          return this.ownStream(value, job);
        } catch (error) { job.release(); throw error; }
      },
    } };
  }

  private ownStream(value: BambuStorageDownload, job: { signal: AbortSignal; release(): void }): BambuStorageDownload {
    const iterator = value.chunks[Symbol.asyncIterator]();
    let closing: Promise<IteratorResult<Uint8Array>> | undefined;
    const close = () => {
      if (!closing) closing = (async () => {
        try { return iterator.return ? await iterator.return() : { done: true as const, value: undefined }; }
        finally { job.signal.removeEventListener('abort', abort); job.release(); }
      })();
      return closing;
    };
    const abort = () => { void close().catch(() => undefined); };
    job.signal.addEventListener('abort', abort, { once: true });
    if (job.signal.aborted) abort();
    let claimed = false;
    return { totalBytes: value.totalBytes, chunks: { [Symbol.asyncIterator]() {
      if (claimed) throw new Error('The storage stream is already owned.'); claimed = true;
      return { next: async () => {
        if (job.signal.aborted) { await close(); throw new StorageHostError({ code: 'cancelled', message: 'Storage reading was cancelled.' }); }
        if (closing) return { done: true, value: undefined };
        try { const next = await iterator.next(); if (next.done) await close(); return next; }
        catch (error) { await close(); throw error; }
      }, return: close };
    } } };
  }

  async reconcile(): Promise<void> {
    for (const job of this.active.values()) {
      try {
        const current = await this.identity(job.target);
        if (!current.ok || current.value.revision !== job.revision) job.controller.abort();
      } catch { job.controller.abort(); }
    }
  }
  async close(): Promise<void> { this.shutdown.abort(); await Promise.all([...this.active.keys()]); }
}
