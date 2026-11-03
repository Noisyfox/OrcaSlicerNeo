import { randomUUID } from 'node:crypto';
import type * as D from '@orca/printer-control/domain';
import type { BambuMediaRequest, BambuMediaStatus } from '../../shared/bambuMedia';
import { thumbnailTarget } from '../projectThumbnail';
import { BambuStorageFiles, storageFailure } from './storageFiles';
const failure = (code: D.ErrorCode, message: string): D.Result<never> => ({ ok: false, error: { code, message } });
interface ImageResource { owner: string; request: D.OpenMediaRequest; descriptor: D.MediaDescriptor; bytes: number; until: number }
interface Pending { owner: string; controller: AbortController; work: Promise<D.Result<D.MediaDescriptor>> }
interface ImageRequest { owner: string; fingerprint: string; result: Promise<D.Result<D.MediaDescriptor>>; until: number; active: boolean }
/** Optional bounded image resources, independent of the live-camera lease. */
export class BambuStorageImages {
  private resources = new Map<string, ImageResource>();
  private requests = new Map<string, ImageRequest>();
  private pending = new Map<string, Pending>();
  private retiredOwners = new Set<string>();
  private closed = false;
  private cancelled = new Set<string>();
  private timer = setInterval(() => {
    const now = Date.now();
    for (const [id, resource] of this.resources) if (resource.until < now) this.release(id);
    for (const [key, request] of this.requests) if (!request.active && !this.pending.has(key) && request.until < now) this.requests.delete(key);
  }, 1000);
  constructor(private readonly files: BambuStorageFiles, private readonly printThumbnail: (file: D.RemoteFileRef, previewId: string) => string | null = () => null) { this.timer.unref(); }
  owns(ref: D.MediaRef) { return ref.id.startsWith('storage-image:'); }
  async call(owner: string, request: BambuMediaRequest) {
    if (this.closed || this.retiredOwners.has(owner)) return failure('cancelled', 'The viewing document closed.');
    if (request.method === 'cancelOpen') {
      const key = `${owner}:${request.input.requestId}`; this.cancelled.add(key);
      while (this.cancelled.size > 128) this.cancelled.delete(this.cancelled.values().next().value!);
      const job = this.pending.get(key); job?.controller.abort(); const result = await job?.work;
      if (result?.ok) this.release(result.value.ref.id);
      for (const [id, resource] of this.resources) if (resource.owner === owner && resource.request.requestId === request.input.requestId) this.release(id);
      return { ok: true as const, value: null };
    }
    if (request.method === 'open') return this.open(owner, request.input);
    const resource = this.resources.get(request.input.id);
    if (!resource || resource.owner !== owner || resource.descriptor.ref.printerId !== request.input.printerId || resource.descriptor.ref.routeId !== request.input.routeId)
      return request.method === 'close' ? { ok: true as const, value: null } : failure('invalid-target', 'The image is unavailable.');
    if (request.method === 'close') { this.release(request.input.id); return { ok: true as const, value: null }; }
    if (request.method === 'renew') {
      const source = resource.request.source;
      if (source.kind !== 'file-preview') return failure('invalid-target', 'The image is unavailable.');
      const current = await this.files.resolveFile(source.target); if (!current.ok) { this.release(request.input.id); return current; }
      resource.until = Date.now() + 60_000; resource.descriptor = { ...resource.descriptor, expiresAtMs: resource.until, revision: resource.descriptor.revision + 1 };
      return { ok: true as const, value: resource.descriptor };
    }
    return { ok: true as const, value: { descriptor: resource.descriptor, state: 'ready', error: null } satisfies BambuMediaStatus };
  }
  private open(owner: string, request: D.OpenMediaRequest): Promise<D.Result<D.MediaDescriptor>> {
    const key = `${owner}:${request.requestId}`, fingerprint = JSON.stringify(request), old = this.requests.get(key);
    if (this.cancelled.has(key)) return Promise.resolve(failure('cancelled', 'Thumbnail reading stopped.'));
    if (old) return old.fingerprint === fingerprint ? old.result : Promise.resolve(failure('invalid-request', 'The image request ID was reused.'));
    if (this.pending.size >= 16 || this.resources.size >= 32) return Promise.resolve(failure('busy', 'Wait for other thumbnail reads to finish.'));
    // Completed request history bounds deduplication, not browsing throughput.
    // Keep in-flight reads and live leases; evict the oldest terminal records.
    while (this.requests.size >= 128) {
      const victim = [...this.requests].find(([key, request]) => !request.active && !this.pending.has(key));
      if (!victim) return Promise.resolve(failure('busy', 'Wait for other thumbnail reads to finish.'));
      this.requests.delete(victim[0]);
    }
    const controller = new AbortController();
    const work = this.read(owner, request, controller.signal).catch(error => ({ ok: false as const, error: storageFailure(error) })).then(result => {
      const entry = this.requests.get(key);
      if (entry && !result.ok) { entry.active = false; entry.until = Date.now() + 60_000; }
      return result;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, { owner, controller, work }); this.requests.set(key, { owner, fingerprint, result: work, until: Date.now() + 60_000, active: true });
    return work;
  }
  private async read(owner: string, request: D.OpenMediaRequest, signal: AbortSignal): Promise<D.Result<D.MediaDescriptor>> {
    if (request.source.kind !== 'file-preview') return failure('invalid-request', 'Unsupported file preview.');
    const ref = request.source.target;
    const printResource = request.source.previewId !== 'thumbnail' ? this.printThumbnail(ref, request.source.previewId) : null;
    if (request.source.previewId !== 'thumbnail' && !printResource) return failure('invalid-request', 'This print thumbnail is unavailable.');
    if (ref.printerId !== request.target.printerId || ref.routeId !== request.target.routeId ||
      request.target.expectedConfigurationRevision !== undefined && request.target.expectedConfigurationRevision !== ref.configurationRevision) return failure('stale-context', 'The file preview target changed.');
    const resolved = await this.files.resolveFile(ref); if (!resolved.ok) return resolved;
    const { source, address } = resolved.value;
    if (!address.path || address.collection === 'model' && !address.name.toLowerCase().endsWith('.3mf')) return failure('preview-unavailable', 'No thumbnail is available.');
    let resource = printResource ?? 'thumbnail';
    if (!printResource && address.collection === 'model') {
      const relationships = await source.resource(address.path, '_rels/.rels', 1024 * 1024, signal);
      if (!relationships) return failure('preview-unavailable', 'The printer does not provide a thumbnail for this file.');
      resource = thumbnailTarget(new TextDecoder('utf-8', { fatal: true }).decode(relationships)).replace(/^\//, '');
    }
    const data = await source.resource(address.path, resource, 4 * 1024 * 1024, signal);
    if (!data) return failure('preview-unavailable', 'The printer does not provide a thumbnail for this file.');
    const mimeType = thumbnailMime(data);
    if (!mimeType || !request.client.imageMimeTypes.includes(mimeType)) return failure('no-compatible-media', 'The thumbnail format is unavailable.');
    const checked = await this.files.resolveFile(ref); if (!checked.ok) return checked;
    if (signal.aborted || this.retiredOwners.has(owner)) return failure('cancelled', 'Thumbnail reading stopped.');
    if ([...this.resources.values()].reduce((sum, image) => sum + image.bytes, data.byteLength) > 16 * 1024 * 1024) return failure('busy', 'Thumbnail memory is full.');
    const id = `storage-image:${randomUUID()}` as D.Id<'media'>, until = Date.now() + 60_000;
    const descriptor: D.MediaDescriptor = { ref: { printerId: ref.printerId, routeId: ref.routeId, id }, source: request.source,
      configurationRevision: ref.configurationRevision, revision: 1, expiresAtMs: until,
      presentation: { kind: 'image', mimeType, url: `data:${mimeType};base64,${Buffer.from(data).toString('base64')}` } };
    this.resources.set(id, { owner, request, descriptor, bytes: data.byteLength, until }); return { ok: true, value: descriptor };
  }
  private release(id: string) {
    const resource = this.resources.get(id); if (!resource) return;
    this.resources.delete(id);
    const request = this.requests.get(`${resource.owner}:${resource.request.requestId}`);
    if (request) { request.result = Promise.resolve(failure('lease-expired', 'The thumbnail was released.')); request.active = false; request.until = Date.now() + 60_000; }
  }
  async closeOwner(owner: string) {
    this.retiredOwners.add(owner);
    const jobs = [...this.pending.values()].filter(job => job.owner === owner); jobs.forEach(job => job.controller.abort()); await Promise.allSettled(jobs.map(job => job.work));
    for (const [id, resource] of this.resources) if (resource.owner === owner) this.release(id);
    for (const [key, request] of this.requests) if (request.owner === owner) this.requests.delete(key);
  }
  async close() { this.closed = true; clearInterval(this.timer); for (const job of this.pending.values()) job.controller.abort(); await Promise.allSettled([...this.pending.values()].map(job => job.work)); this.resources.clear(); this.requests.clear(); }
}
/** Bound decoded dimensions before handing optional images to the renderer. */
export function thumbnailMime(data: Uint8Array): 'image/png' | 'image/jpeg' | null {
  const b = Buffer.from(data), dimensions = (w: number, h: number) => w > 0 && h > 0 && w <= 4096 && h <= 4096;
  if (b.length >= 33 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && b.toString('ascii', 12, 16) === 'IHDR')
    return dimensions(b.readUInt32BE(16), b.readUInt32BE(20)) ? 'image/png' : null;
  if (b[0] !== 255 || b[1] !== 216) return null;
  for (let offset = 2; offset + 4 < b.length;) {
    if (b[offset++] !== 255) return null;
    while (b[offset] === 255) offset++;
    const marker = b[offset++]; if (marker === 0xda || marker === 0xd9 || offset + 2 > b.length) return null;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    const length = b.readUInt16BE(offset); if (length < 2 || offset + length > b.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) return dimensions(b.readUInt16BE(offset + 5), b.readUInt16BE(offset + 3)) ? 'image/jpeg' : null;
    offset += length;
  }
  return null;
}
