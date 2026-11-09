/** U1 G-code collections and previews over the configured Moonraker route. */
import type * as D from '../domain';
import { safe, supported, type ConfigurationEntry, type HttpServiceBehavior, type HttpServiceContext, type ResolvedConfiguration } from '../http-service';
import { fail, record } from '../moonraker-http';
import { copy, newId } from '../operations';
import { gcodeMetadataEndpoint, gcodeThumbnailPath, inlineThumbnail, readGcodeThumbnail } from './file-thumbnail';
import { isU1Gcode, u1FileId, u1GcodeEndpoint, u1GcodePrefix, u1GcodeRef, u1GcodeStorage, u1InternalStorage as internal,
  u1StorageRouteDigest, u1TimelapseRef, u1UsbStorage as usb } from './file-reference';
import { U1Timelapses, u1TimelapseCollectionId, type U1TimelapseTransport } from './timelapse';
import { readU1Download } from './storage-download';

const collection = { id: 'gcode' as D.Id<'file-collection'>, name: 'G-code', kinds: ['print-file'], actions: ['download', 'delete'] } as const satisfies D.StorageCollection;
const mediaPrefix = 'snapmaker-thumbnail:';
const snapshotLifetimeMs = 5 * 60_000;
export const u1DeleteCapability = supported([{ storageId: internal }, { storageId: usb }] as const);

export function u1StorageCapabilities(hasTimelapses: boolean): Pick<D.FileCapabilities, 'list' | 'preview' | 'download'> {
  return {
    list: supported({ storageIds: [internal, usb], kinds: hasTimelapses ? ['print-file', 'timelapse'] : ['print-file'] }),
    download: supported([{ storageId: internal, byteRanges: false }, { storageId: usb, byteRanges: false }]),
    preview: supported([{ storageId: internal, kinds: hasTimelapses ? ['thumbnail', 'video'] : ['thumbnail'] }, { storageId: usb, kinds: ['thumbnail'] }]),
  };
}

interface Snapshot {
  configurationRevision: D.Revision;
  revision: D.Revision;
  expiresAt: number;
  files: Record<string, D.RemoteFile[]>;
  thumbnails: Map<string, string | null>;
}

function storage(id: D.Id<'storage'>, availability: D.Availability, timelapse?: D.StorageCollection): D.PrinterStorage {
  return {
    id, name: id === usb ? 'USB drive' : 'Internal', kind: id === usb ? 'removable' : 'internal',
    availability, capacityBytes: null, freeBytes: null,
    browsing: supported({ kind: 'collections', collections: timelapse ? [collection, timelapse] : [collection] }),
  };
}

function readSignal(options?: D.ReadOptions): AbortSignal {
  const timeout = AbortSignal.timeout(15_000);
  return options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

function checkRead(signal: AbortSignal) {
  if (signal.aborted) fail('cancelled', 'Printer storage request cancelled.');
}

function previewId(file: D.RemoteFileRef): D.Id<'preview-option'> {
  return `${file.fileId}:thumbnail` as D.Id<'preview-option'>;
}

export class U1Storage {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly mutations = new WeakMap<ConfigurationEntry, number>();
  private readonly timelapses?: U1Timelapses;
  constructor(private readonly context: HttpServiceContext, transport?: U1TimelapseTransport) {
    if (transport) this.timelapses = new U1Timelapses(context, transport);
  }

  validateDeletion({ printer, entry }: ResolvedConfiguration, file: D.RemoteFileRef): void {
    const target = this.context.targetFor(printer.id);
    if (file.printerId !== target.printerId || file.routeId !== target.routeId) fail('invalid-target', 'File belongs to another printer route.');
    if (file.configurationRevision !== entry.revision) fail('stale-context', 'The printer configuration changed. Refresh Storage.');
    if (this.timelapses?.ownsFile(file)) u1TimelapseRef(file);
    else u1GcodeRef(file);
  }

  async delete(resolved: ResolvedConfiguration, file: D.RemoteFileRef): Promise<void> {
    this.validateDeletion(resolved, file);
    const signal = readSignal();
    if (this.timelapses?.ownsFile(file)) return this.timelapses.delete(file, signal);
    const { filename, digest } = u1GcodeRef(file);
    if (digest !== await u1StorageRouteDigest(resolved.printer)) fail('stale-context', 'The printer configuration changed. Refresh Storage.');
    await this.verify(file, file.configurationRevision, signal);
    try { await this.context.http.deleteGcode(resolved.printer, u1GcodeEndpoint(filename), filename, signal); }
    finally {
      this.mutations.set(resolved.entry, (this.mutations.get(resolved.entry) ?? 0) + 1);
      this.snapshots.delete(resolved.printer.id);
    }
  }

  private current({ printer, entry }: ResolvedConfiguration): Snapshot | undefined {
    const snapshot = this.snapshots.get(printer.id);
    if (snapshot?.configurationRevision !== entry.revision) return;
    if (snapshot.expiresAt > Date.now()) return snapshot;
    this.snapshots.delete(printer.id);
  }

  private async verify(target: D.PrinterTarget, revision: D.Revision, signal: AbortSignal) {
    await this.context.resolve({ ...target, expectedConfigurationRevision: revision });
    checkRead(signal);
  }

  private async scan(resolved: ResolvedConfiguration, signal: AbortSignal): Promise<Snapshot> {
    const { printer, entry } = resolved;
    const mutation = this.mutations.get(entry);
    const target = this.context.targetFor(printer.id);
    const response = await this.context.http.getArray(printer, '/server/files/list?root=gcodes', signal);
    if (response.length > 20_000) fail('out-of-range', 'The printer reported more than 20,000 files.');
    const files: Snapshot['files'] = { [internal]: [], [usb]: [] };
    const digest = await u1StorageRouteDigest(printer);
    const seen = new Set<string>();
    for (const item of response) {
      const { path, size, modified } = record(item);
      if (!isU1Gcode(path) || seen.has(path)) continue;
      seen.add(path);
      const storageId = u1GcodeStorage(path);
      files[storageId].push({
        ref: { ...target, configurationRevision: entry.revision, storageId, fileId: u1FileId(u1GcodePrefix, digest, path) },
        directoryId: null, name: path.slice(path.lastIndexOf('/') + 1), mimeType: null,
        sizeBytes: typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : null,
        createdAtMs: null, modifiedAtMs: typeof modified === 'number' && Number.isFinite(new Date(modified * 1000).getTime()) ? modified * 1000 : null,
        metadata: { kind: 'print-file', format: 'gcode', estimatedDurationSeconds: null, materialKeys: null },
      });
    }
    await this.verify(target, entry.revision, signal);
    if (mutation !== this.mutations.get(entry)) fail('listing-expired', 'This file list changed during refresh. Refresh Storage.');
    const snapshot = { configurationRevision: entry.revision, revision: newId<'listing'>(), expiresAt: Date.now() + snapshotLifetimeMs, files, thumbnails: new Map() };
    this.snapshots.delete(printer.id);
    this.snapshots.set(printer.id, snapshot);
    if (this.snapshots.size > 4) this.snapshots.delete(this.snapshots.keys().next().value!);
    return snapshot;
  }

  readonly files: NonNullable<HttpServiceBehavior['files']> = {
    download: (request, options) => safe(async () => {
      const { printer } = await this.context.resolve({ ...request.target, expectedConfigurationRevision: request.target.configurationRevision });
      const result = await readU1Download(printer, request, options);
      if (!result.ok) fail(result.error.code, result.error.message);
      return result.value;
    }),
    listStorages: (target, options) => safe(async () => {
      const resolved = await this.context.resolve(target);
      const snapshot = await this.scan(resolved, readSignal(options));
      return [storage(internal, { kind: 'available' }, this.timelapses?.collection(resolved.printer)), storage(usb, snapshot.files[usb].length
        ? { kind: 'available' }
        : { kind: 'unknown', reason: 'No USB G-code files were reported. Refresh after connecting a USB drive or adding files.' })];
    }),
    list: (request, options) => safe(async () => {
      const { target, storageId, location, cursor, kinds, pageSize = 100 } = request;
      const signal = readSignal(options);
      if (this.timelapses && location.kind === 'collection' && location.collectionId === u1TimelapseCollectionId)
        return this.timelapses.list(request, signal);
      if ((storageId !== internal && storageId !== usb) || location.kind !== 'collection' || location.collectionId !== collection.id)
        fail('invalid-target', 'Unknown U1 file collection.');
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500) fail('invalid-request', 'Invalid U1 file page size.');
      const resolved = await this.context.resolve(target);
      checkRead(signal);
      const current = this.current(resolved);
      if (!current && cursor !== undefined) fail('listing-expired', 'This file list has expired. Refresh Storage.');
      const snapshot = current ?? await this.scan(resolved, signal);
      const files = !kinds || kinds.includes('print-file') ? snapshot.files[storageId] : [];
      const cursorPrefix = `${snapshot.revision}:${storageId}:${pageSize}:`;
      let offset = 0;
      if (cursor !== undefined) {
        offset = Number(cursor.slice(cursorPrefix.length));
        if (!cursor.startsWith(cursorPrefix) || !Number.isSafeInteger(offset) || offset <= 0 || offset >= files.length || offset % pageSize !== 0)
          fail('listing-expired', 'This file list has changed. Refresh Storage.');
      }
      const end = offset + pageSize;
      return { directories: [], files: copy(files.slice(offset, end)), nextCursor: end < files.length ? `${cursorPrefix}${end}` : null,
        listingRevision: snapshot.revision, pagination: 'snapshot' };
    }),
    listPreviews: (file, options) => safe(async () => {
      const signal = readSignal(options);
      if (this.timelapses?.ownsFile(file)) return this.timelapses.previews(file, signal);
      const resolved = await this.resolveFile(file, signal);
      const path = await this.thumbnail(resolved, signal);
      return { file: copy(file), options: path ? [{ id: previewId(file), kind: 'thumbnail', label: 'Thumbnail', contentFormat: null }] : [] };
    }),
  };

  private async resolveFile(file: D.RemoteFileRef, signal: AbortSignal) {
    const { filename } = u1GcodeRef(file);
    const target = { printerId: file.printerId, routeId: file.routeId, expectedConfigurationRevision: file.configurationRevision };
    const resolved = await this.context.resolve(target);
    checkRead(signal);
    return { ...resolved, filename };
  }

  private async thumbnail(resolved: ResolvedConfiguration & { filename: string }, signal: AbortSignal): Promise<string | null> {
    const { printer, entry, filename } = resolved;
    const cache = this.current(resolved)?.thumbnails;
    const cached = cache?.get(filename);
    if (cached !== undefined) return cached;
    const metadata = await this.context.http.getOptional(printer, gcodeMetadataEndpoint(filename), signal);
    await this.verify(this.context.targetFor(printer.id), entry.revision, signal);
    const path = (metadata && gcodeThumbnailPath(filename, metadata)) || null;
    cache?.set(filename, path);
    if (cache && cache.size > 128) cache.delete(cache.keys().next().value!);
    return path;
  }

  open: D.PrinterMedia['open'] = (request, options) => safe(async () => {
    const { source, target, requestId } = request;
    if (source.kind !== 'file-preview') fail('unsupported', 'U1 Storage only opens file previews.');
    const file = source.target;
    const signal = readSignal(options);
    if (this.timelapses?.ownsFile(file)) return this.timelapses.open({ ...request, source }, signal);
    if (target.printerId !== file.printerId || target.routeId !== file.routeId ||
        (target.expectedConfigurationRevision !== undefined && target.expectedConfigurationRevision !== file.configurationRevision) ||
        source.previewId !== previewId(file)) fail('invalid-target', 'Invalid U1 file preview.');
    const resolved = await this.resolveFile(file, signal);
    const path = await this.thumbnail(resolved, signal);
    if (!path) fail('preview-unavailable', 'No thumbnail is available for this file.');
    const { bytes, mimeType } = await readGcodeThumbnail(this.context.http, resolved.printer, path, signal);
    await this.verify(target, file.configurationRevision, signal);
    if (!request.client.imageMimeTypes.includes(mimeType)) fail('no-compatible-media', 'The client cannot display this thumbnail.');
    // Inline images have no provider-side lease or credentials to retain.
    return {
      ref: { printerId: file.printerId, routeId: file.routeId, id: `${mediaPrefix}${requestId}` as D.Id<'media'> },
      configurationRevision: file.configurationRevision, revision: 1, source: copy(source),
      presentation: { kind: 'image', mimeType, url: inlineThumbnail(bytes, mimeType) },
      expiresAtMs: null, acceptsUserActivity: false,
    };
  });

  ownsMedia(ref: D.MediaRef): boolean { return ref.id.startsWith(mediaPrefix) || this.timelapses?.ownsMedia(ref) === true; }
  close: D.PrinterMedia['close'] = ref => safe(async () => this.timelapses?.ownsMedia(ref) ? this.timelapses.close(ref) : null);
}
