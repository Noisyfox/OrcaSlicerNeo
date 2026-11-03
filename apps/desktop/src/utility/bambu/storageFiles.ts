/** Agent-owned remote references and browsing. No host destination or active-project state. */
import { randomUUID } from 'node:crypto';
import type * as D from '@orca/printer-control/domain';
import { BambuStorageError, type BambuStorageCollection, type BambuStorageEntry, type BambuStorageFile,
  type BambuStorageDownload } from '@orca/bambu-native';

export interface BambuStorageSource {
  configurationRevision: string;
  discover(signal?: AbortSignal): Promise<readonly string[]>;
  list(storage: string, collection: BambuStorageCollection, signal?: AbortSignal): Promise<readonly BambuStorageEntry[]>;
  download(file: BambuStorageFile, signal?: AbortSignal): Promise<BambuStorageDownload>;
  remove(file: BambuStorageFile, signal?: AbortSignal): Promise<void>;
  resource(path: string, resource: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array | null>;
}
export type ResolveStorageSource = (target: D.PrinterTarget) => Promise<D.Result<BambuStorageSource>>;
export class StorageHostError extends Error { constructor(readonly detail: D.PrinterError) { super(detail.message); } }
const failure = (code: D.ErrorCode, message: string) => ({ ok: false as const, error: { code, message } });
export function storageFailure(error: unknown): D.PrinterError {
  if (error instanceof StorageHostError) return error.detail;
  if (error instanceof BambuStorageError) {
    if (error.code === 'cancelled') return { code: 'cancelled', message: 'Storage reading was cancelled.' };
    if (error.code === 'device-rejected') {
      const code: D.ErrorCode = error.result === 10 ? 'file-not-found' : error.result === 17 ? 'storage-unavailable'
        : error.result === 18 ? 'unsupported' : error.result === 5 ? 'busy' : 'device-rejected';
      return { code, message: code === 'file-not-found' ? 'The file no longer exists on the printer.'
        : code === 'storage-unavailable' ? 'The printer storage is unavailable.' : 'The printer rejected this storage operation.' };
    }
    if (error.code === 'invalid-response') return { code: 'device-failed', message: 'The printer returned inconsistent storage data.' };
  }
  return { code: 'transport', message: 'The printer storage could not be reached.' };
}
const collections = [
  { id: 'model', name: 'Print files', kind: 'print-file' },
  { id: 'timelapse', name: 'Timelapses', kind: 'timelapse' },
  { id: 'video', name: 'Recordings', kind: 'recording' },
] as const;
const collection = (value: string) => collections.find(item => item.id === value);
const unavailable = { kind: 'blocked', reasons: [{ code: 'unsupported', message: 'Remote print inspection is not available yet.' }] } as const;
interface FileAddress { collection: BambuStorageCollection; name: string; path: string }
const fileId = (value: FileAddress) => `bambu-file:${Buffer.from(JSON.stringify(value)).toString('base64url')}` as D.Id<'remote-file'>;
function address(ref: D.RemoteFileRef): FileAddress | null {
  try {
    if (!ref.fileId.startsWith('bambu-file:') || ref.fileId.length > 16_384 || !/^[a-zA-Z0-9_-]{1,64}$/.test(ref.storageId)) return null;
    const value = JSON.parse(Buffer.from(ref.fileId.slice(11), 'base64url').toString('utf8')) as FileAddress;
    if (!value || Object.keys(value).some(key => !['collection', 'name', 'path'].includes(key)) || !collection(value.collection) ||
      typeof value.name !== 'string' || !value.name || value.name.length > 4096 || value.name === '.' || value.name === '..' || /[\x00-\x1f/\\]/.test(value.name) ||
      typeof value.path !== 'string' || value.path.length > 4096 || !value.path && value.collection !== 'timelapse' || /[\x00-\x1f]/.test(value.path) || value.path.startsWith('mem:') ||
      value.path.split(/[\\/]/).includes('..') || fileId(value) !== ref.fileId) return null;
    return value;
  } catch { return null; }
}
const wireFile = (value: FileAddress): BambuStorageFile => value.path ? { path: value.path } : { name: value.name };
function remoteFile(target: D.PrinterTarget, revision: string, storageId: D.Id<'storage'>, kind: BambuStorageCollection, entry: BambuStorageEntry): D.RemoteFile {
  return { ref: { ...target, configurationRevision: revision, storageId, fileId: fileId({ collection: kind, name: entry.name, path: entry.path }) },
    directoryId: null, name: entry.name, mimeType: null, sizeBytes: entry.sizeBytes, createdAtMs: null,
    modifiedAtMs: entry.modifiedAtSeconds === null ? null : entry.modifiedAtSeconds * 1000,
    metadata: kind === 'model' ? { kind: 'print-file', format: entry.name.toLowerCase().endsWith('.gcode') ? 'gcode' : 'vendor:bambu-3mf',
      estimatedDurationSeconds: null, materialKeys: null } : { kind: kind === 'video' ? 'recording' : 'timelapse', durationSeconds: null, width: null, height: null } };
}
interface Listing { scope: string; files: readonly D.RemoteFile[]; expires: number }

export class BambuStorageFiles {
  private listings = new Map<string, Listing>();
  constructor(private readonly resolve: ResolveStorageSource, private readonly now = () => Date.now()) {}

  async listStorages(target: D.PrinterTarget, options?: D.ReadOptions): Promise<D.Result<readonly D.PrinterStorage[]>> {
    const source = await this.resolve(target); if (!source.ok) return source;
    const revision = source.value.configurationRevision;
    try {
      const names = await source.value.discover(options?.signal);
      const current = await this.resolve(target); if (!current.ok) return current;
      if (current.value.configurationRevision !== revision) return failure('stale-context', 'The printer configuration changed while loading storage.');
      if (options?.signal?.aborted) return failure('cancelled', 'Storage reading was cancelled.');
      const [first, ...rest] = collections.map((item): D.StorageCollection => ({ id: item.id as D.Id<'file-collection'>,
        name: item.name, kinds: [item.kind], actions: ['download', 'delete'] }));
      return { ok: true, value: names.map(name => ({ id: name as D.Id<'storage'>,
        name: name === 'internal' ? 'Internal storage' : name === 'sdcard' ? 'SD card' : name === 'udisk' ? 'USB storage' : name,
        kind: name === 'internal' ? 'internal' : name === 'sdcard' || name === 'udisk' ? 'removable' : 'other',
        availability: { kind: 'available' }, capacityBytes: null, freeBytes: null,
        browsing: { kind: 'supported', constraints: { kind: 'collections', collections: name === 'internal' ? [first] : [first, ...rest] } },
      })) };
    } catch (error) { return { ok: false, error: storageFailure(error) }; }
  }

  async list(request: D.ListFilesRequest, options?: D.ReadOptions): Promise<D.Result<D.RemoteFilePage>> {
    const selected = request.location.kind === 'collection' && collection(request.location.collectionId);
    const pageSize = request.pageSize ?? 100;
    if (!selected || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500 ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(request.storageId) || request.kinds?.length === 0 || request.kinds?.some(kind => kind !== selected.kind))
      return failure('invalid-request', 'This storage collection request is invalid.');
    const source = await this.resolve(request.target); if (!source.ok) return source;
    const revision = source.value.configurationRevision;
    const scope = JSON.stringify([request.target.printerId, request.target.routeId, revision, request.storageId, selected.id, request.kinds ?? null, pageSize]);
    for (const [id, listing] of this.listings) if (listing.expires <= this.now()) this.listings.delete(id);
    let id: string, offset = 0, listing: Listing | undefined;
    if (request.cursor !== undefined) {
      const match = /^([a-f\d-]{36}):(\d+)$/.exec(request.cursor);
      if (!match) return failure('listing-expired', 'Refresh this storage listing.');
      id = match[1]; offset = Number(match[2]); listing = this.listings.get(id);
      if (!listing || listing.scope !== scope || !Number.isSafeInteger(offset) || offset <= 0 || offset >= listing.files.length || offset % pageSize !== 0)
        return failure('listing-expired', 'This listing no longer matches the selected storage or query. Refresh it.');
    } else {
      try {
        const entries = await source.value.list(request.storageId, selected.id, options?.signal);
        if (entries.length > 20_000) return failure('out-of-range', 'This storage listing exceeds the adapter limit.');
        const current = await this.resolve(request.target);
        if (!current.ok) return current;
        if (current.value.configurationRevision !== revision) return failure('stale-context', 'The printer configuration changed while loading storage.');
        listing = { scope, files: entries.map(entry => remoteFile(request.target, revision, request.storageId, selected.id, entry)), expires: this.now() + 300_000 };
        id = randomUUID();
        while (this.listings.size && (this.listings.size >= 8 || [...this.listings.values()].reduce((n, value) => n + value.files.length, listing.files.length) > 50_000))
          this.listings.delete(this.listings.keys().next().value!);
        this.listings.set(id, listing);
      } catch (error) { return { ok: false, error: storageFailure(error) }; }
    }
    if (options?.signal?.aborted) return failure('cancelled', 'Storage reading was cancelled.');
    const next = offset + pageSize;
    return { ok: true, value: { directories: [], files: structuredClone(listing.files.slice(offset, next)),
      nextCursor: next < listing.files.length ? `${id}:${next}` : null, listingRevision: id, pagination: 'snapshot' } };
  }

  async resolveFile(ref: D.RemoteFileRef): Promise<D.Result<{ source: BambuStorageSource; address: FileAddress; file: BambuStorageFile }>> {
    const parsed = address(ref); if (!parsed) return failure('invalid-target', 'This remote file reference is invalid.');
    const source = await this.resolve({ printerId: ref.printerId, routeId: ref.routeId }); if (!source.ok) return source;
    if (source.value.configurationRevision !== ref.configurationRevision) return failure('stale-context', 'The printer configuration changed. Refresh storage.');
    return { ok: true, value: { source: source.value, address: parsed, file: wireFile(parsed) } };
  }

  async stat(ref: D.RemoteFileRef, options?: D.ReadOptions): Promise<D.Result<D.RemoteFileDetails>> {
    const resolved = await this.resolveFile(ref); if (!resolved.ok) return resolved;
    const { source, address } = resolved.value;
    try {
      const entries = await source.list(ref.storageId, address.collection, options?.signal);
      const current = await this.resolveFile(ref); if (!current.ok) return current;
      if (options?.signal?.aborted) return failure('cancelled', 'Storage reading was cancelled.');
      const entry = entries.find(entry => entry.path === address.path && entry.name === address.name);
      if (!entry) return failure('file-not-found', 'The file no longer exists on the printer.');
      return { ok: true, value: { file: remoteFile({ printerId: ref.printerId, routeId: ref.routeId }, ref.configurationRevision, ref.storageId, address.collection, entry),
        assessedAtMs: this.now(), capabilityRevision: 'bambu-storage-1', availability: { download: { kind: 'available' }, delete: { kind: 'available' }, startPrint: unavailable } } };
    } catch (error) { return { ok: false, error: storageFailure(error) }; }
  }

  async listPreviews(ref: D.RemoteFileRef): Promise<D.Result<D.FilePreviewListing>> {
    const resolved = await this.resolveFile(ref); if (!resolved.ok) return resolved;
    const address = resolved.value.address;
    const thumbnail = !!address.path && (address.collection !== 'model' || address.name.toLowerCase().endsWith('.3mf'));
    return { ok: true, value: { file: { ...ref }, options: thumbnail ? [{ id: 'thumbnail' as D.Id<'preview-option'>, kind: 'thumbnail', label: 'Thumbnail', contentFormat: null }] : [] } };
  }

  async download(request: { target: D.RemoteFileRef; range?: D.ByteRange }, options?: D.ReadOptions): Promise<D.Result<D.DownloadedFile>> {
    if (request.range) return failure('range-not-supported', 'This reader supports complete files only.');
    const ref = { ...request.target }, resolved = await this.resolveFile(ref); if (!resolved.ok) return resolved;
    try {
      const value = await resolved.value.source.download(resolved.value.file, options?.signal);
      const iterator = value.chunks[Symbol.asyncIterator]();
      const protect = async <T>(read: () => Promise<T>): Promise<T> => {
        try { return await read(); } catch (error) { throw Object.assign(new Error('Storage reading failed.'), { detail: storageFailure(error) }); }
      };
      let claimed = false;
      return { ok: true, value: { file: ref, suggestedFileName: resolved.value.address.name, mimeType: null,
        totalBytes: value.totalBytes, responseBytes: value.totalBytes, returnedRange: null,
        chunks: { [Symbol.asyncIterator]() {
          if (claimed) throw new Error('The storage read is already owned.'); claimed = true;
          return { next: () => protect(() => iterator.next()), return: () => protect(async () => iterator.return ? iterator.return() : { done: true, value: undefined }) };
        } },
      } };
    } catch (error) { return { ok: false, error: storageFailure(error) }; }
  }

  invalidate(ref: D.RemoteFileRef): void {
    for (const [id, listing] of this.listings) if (listing.files.some(file => file.ref.printerId === ref.printerId && file.ref.routeId === ref.routeId && file.ref.storageId === ref.storageId)) this.listings.delete(id);
  }
}
