import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type * as D from '@orca/printer-control/domain';
import type { BambuMediaAttachment, BambuMediaRequest, BambuMediaStatus } from '../../shared/bambuMedia';
import type { CameraPort } from './mediaChannel';
import { BambuStorageFiles, storageFailure } from './storageFiles';
import { StoredVideoCache } from '../media/storedVideoCache';
import { StoredVideoError } from '../media/progressiveMp4';
const failure = (code: D.ErrorCode, message: string): D.Result<never> => ({ ok: false, error: { code, message } });
const errorDetail = (error: unknown): D.PrinterError => error instanceof StoredVideoError ? { code: 'no-compatible-media', message: error.message }
  : error && typeof error === 'object' && 'code' in error && ['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EIO'].includes(String(error.code))
    ? { code: 'storage-unavailable', message: 'The temporary video cache could not be read or written.' }
  : error && typeof error === 'object' && 'detail' in error ? (error as D.PrinterStreamError).detail : storageFailure(error);
interface Resource {
  owner: string; request: D.OpenMediaRequest; descriptor: D.MediaDescriptor; cache: StoredVideoCache;
  closing?: Promise<void>; attachment?: number;
  reader?: { controller: AbortController; done: Promise<void>; port: CameraPort };
}
/** Agent authorization wraps host disk delivery; the main-host FIFO admits opens before any remote read. */
export class BambuStorageVideos {
  private resources = new Map<string, Resource>();
  private requests = new Map<string, { fingerprint: string; result: Promise<D.Result<D.MediaDescriptor>>; until: number }>();
  private cancelled = new Set<string>();
  private closed = false;
  private dirty = false;
  private root: string;
  private initialized: Promise<void>;
  private timer = setInterval(() => {
    if (this.dirty) { this.dirty = false; this.publish(); }
    for (const resource of this.resources.values()) if (!resource.closing && resource.descriptor.expiresAtMs! < Date.now()) void this.release(resource).catch(() => this.publish());
    for (const [key, request] of this.requests) if (request.until < Date.now()) this.requests.delete(key);
  }, 250);
  constructor(private readonly files: BambuStorageFiles, directory: string, private readonly publish: () => void) {
    this.root = join(directory, `process-${process.pid}-${randomUUID()}`);
    this.initialized = this.initialize(directory); void this.initialized.catch(() => {}); this.timer.unref();
  }
  private async initialize(directory: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const match = /^process-(\d+)-[a-f\d-]{36}$/.exec(entry.name);
      if (!entry.isDirectory() || !match) continue;
      try { process.kill(Number(match[1]), 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') await rm(join(directory, entry.name), { recursive: true, force: true }); }
    }
    await mkdir(this.root, { mode: 0o700 });
  }
  owns(ref: D.MediaRef) { return ref.id.startsWith('storage-video:'); }
  private resource(owner: string, ref: D.MediaRef) {
    const item = this.resources.get(ref.id);
    return item?.owner === owner && item.descriptor.ref.printerId === ref.printerId && item.descriptor.ref.routeId === ref.routeId ? item : undefined;
  }
  private descriptor(resource: Resource): D.MediaDescriptor {
    const original = resource.descriptor, video = original.presentation;
    return video.kind !== 'video' ? original : { ...original, presentation: { ...video,
      cachedRanges: resource.cache.cachedEnd ? [{ startSeconds: 0, endSeconds: resource.cache.cachedEnd }] : [] } };
  }
  async waitRead(owner: string, ref: D.MediaRef): Promise<D.Result<null>> {
    const resource = this.resource(owner, ref); if (!resource) return failure('invalid-target', 'The video was closed.');
    await resource.cache.done;
    return resource.cache.error ? { ok: false, error: errorDetail(resource.cache.error) } : { ok: true, value: null };
  }
  async call(owner: string, request: BambuMediaRequest) {
    if (request.method === 'cancelOpen') {
      const key = `${owner}:${request.input.requestId}`; this.cancelled.add(key);
      while (this.cancelled.size > 128) this.cancelled.delete(this.cancelled.values().next().value!);
      await Promise.all([...this.resources.values()].filter(r => r.owner === owner && r.request.requestId === request.input.requestId).map(r => this.release(r)));
      return { ok: true as const, value: null };
    }
    if (request.method === 'open') {
      const key = `${owner}:${request.input.requestId}`, fingerprint = JSON.stringify(request.input), previous = this.requests.get(key);
      if (previous) return previous.fingerprint === fingerprint ? previous.result : failure('invalid-request', 'The media request ID was reused.');
      if (this.closed || this.requests.size >= 64 || this.resources.size >= 2) return failure('busy', 'Close another stored video before opening this one.');
      const result = this.open(owner, request.input, key).catch(error => ({ ok: false as const, error: errorDetail(error) }));
      this.requests.set(key, { fingerprint, result, until: Date.now() + 60_000 }); return result;
    }
    const resource = this.resource(owner, request.input);
    if (!resource) return request.method === 'close' ? { ok: true as const, value: null } : failure('lease-expired', 'This video was closed.');
    if (request.method === 'close') { await this.release(resource); return { ok: true as const, value: null }; }
    if (request.method === 'renew') {
      const source = resource.request.source;
      if (source.kind !== 'file-preview') return failure('invalid-target', 'Invalid video source.');
      const current = await this.files.resolveFile(source.target);
      if (!current.ok) { await this.release(resource); return current; }
      resource.descriptor.expiresAtMs = Date.now() + 60_000; resource.descriptor.revision++;
      return { ok: true as const, value: this.descriptor(resource) };
    }
    return { ok: true as const, value: { descriptor: this.descriptor(resource), state: resource.cache.error ? 'interrupted' : 'ready',
      error: resource.cache.error ? errorDetail(resource.cache.error) : null } satisfies BambuMediaStatus };
  }
  private async open(owner: string, request: D.OpenMediaRequest, key: string): Promise<D.Result<D.MediaDescriptor>> {
    await this.initialized;
    if (request.source.kind !== 'file-preview' || request.source.previewId !== 'video') return failure('invalid-request', 'Invalid stored video preview.');
    const ref = request.source.target;
    if (ref.printerId !== request.target.printerId || ref.routeId !== request.target.routeId || request.target.expectedConfigurationRevision !== undefined && request.target.expectedConfigurationRevision !== ref.configurationRevision)
      return failure('stale-context', 'The video target changed.');
    if (!request.client.video.some(v => v.transport === 'mse-fmp4' && v.codecIds.includes('h264'))) return failure('no-compatible-media', 'This host cannot play stored AVC video. Download it to use a system player.');
    const resolved = await this.files.resolveFile(ref); if (!resolved.ok) return resolved;
    if (resolved.value.address.collection === 'model') return failure('invalid-target', 'This file is not a stored video.');
    if (this.closed || this.cancelled.has(key)) return failure('cancelled', 'Video opening stopped.');
    if (this.resources.size >= 2) return failure('busy', 'Close another stored video before opening this one.');
    const id = `storage-video:${randomUUID()}` as D.Id<'media'>;
    const resource: Resource = { owner, request, descriptor: { ref: { printerId: ref.printerId, routeId: ref.routeId, id }, source: request.source,
      configurationRevision: ref.configurationRevision, revision: 1, expiresAtMs: Date.now() + 60_000, acceptsUserActivity: false,
      presentation: { kind: 'video', delivery: { transport: 'mse-fmp4', streamId: randomUUID() as D.Id<'media-stream'>, mimeType: '' },
        profile: null, durationSeconds: null, seekable: true, codecId: 'h264', live: false, cachedRanges: [] } },
      cache: new StoredVideoCache(this.root, signal => this.files.download({ target: ref }, { signal }), () => {
        resource.descriptor.revision++; this.dirty = true;
      }) };
    this.resources.set(id, resource);
    try {
      const index = await resource.cache.ready;
      if (this.closed || this.cancelled.has(key)) { await this.release(resource); return failure('cancelled', 'Video opening stopped.'); }
      const video = resource.descriptor.presentation as Extract<D.MediaPresentation, { kind: 'video' }>;
      video.delivery = { ...video.delivery as Extract<D.VideoDelivery, { transport: 'mse-fmp4' }>, mimeType: index.mimeType };
      video.durationSeconds = index.durationSeconds; video.profile = { id: 'stored', width: index.width, height: index.height, framesPerSecond: null };
      return { ok: true, value: this.descriptor(resource) };
    } catch (error) { await this.release(resource); throw error; }
  }
  async attach(owner: string, request: BambuMediaAttachment, port: CameraPort) {
    const resource = this.resource(owner, request.media), video = resource?.descriptor.presentation;
    if (!resource || resource.closing || video?.kind !== 'video' || !('streamId' in video.delivery) || video.delivery.streamId !== request.streamId) {
      port.postMessage({ type: 'error', error: { code: 'invalid-target', message: 'This stored video stream is unavailable.' } }); port.close(); return;
    }
    const attachment = resource.attachment = (resource.attachment ?? 0) + 1;
    const previous = resource.reader; previous?.controller.abort(); previous?.port.close(); await previous?.done;
    if (resource.closing || resource.attachment !== attachment || !this.resources.has(request.media.id)) { port.close(); return; }
    const controller = new AbortController();
    const iterator = resource.cache.stream(request.startSeconds, controller.signal)[Symbol.asyncIterator]();
    let pulling = false, finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    let stopped = false;
    const stop = () => { if (stopped) return; stopped = true; controller.abort(); void iterator.return?.().then(finish, finish); };
    controller.signal.addEventListener('abort', stop, { once: true });
    resource.reader = { controller, port, done };
    port.on('close', stop);
    port.on('message', ({ data }) => {
      if (data !== 'pull' || pulling || controller.signal.aborted) { port.close(); stop(); return; }
      pulling = true;
      void iterator.next().then(next => {
        if (controller.signal.aborted) return;
        if (next.done) { port.postMessage({ type: 'closed' }); port.close(); stop(); }
        else port.postMessage({ type: 'packet', packet: next.value });
      }).catch(error => { if (!controller.signal.aborted) { port.postMessage({ type: 'error', error: errorDetail(error) }); port.close(); stop(); } })
        .finally(() => { pulling = false; });
    }); port.start();
  }
  private release(resource: Resource): Promise<void> { return resource.closing ??= this.releaseResource(resource); }
  private async releaseResource(resource: Resource) {
    resource.reader?.controller.abort(); resource.reader?.port.close(); await resource.reader?.done;
    await resource.cache.close(); this.resources.delete(resource.descriptor.ref.id);
    const request = this.requests.get(`${resource.owner}:${resource.request.requestId}`);
    if (request) request.result = Promise.resolve(failure('lease-expired', 'The video was released.'));
    this.publish();
  }
  async closeOwner(owner: string) {
    for (const key of this.requests.keys()) if (key.startsWith(`${owner}:`)) this.cancelled.add(key);
    await Promise.all([...this.resources.values()].filter(r => r.owner === owner).map(r => this.release(r)));
  }
  async close() { this.closed = true; clearInterval(this.timer); await Promise.all([...this.resources.values()].map(r => this.release(r))); await this.initialized; await rm(this.root, { recursive: true, force: true }); }
}
