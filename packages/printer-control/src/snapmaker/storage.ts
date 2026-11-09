/** Read-only U1 G-code collections and previews over the configured Moonraker route. */
import type * as D from '../domain';
import { safe, supported, type HttpServiceBehavior, type HttpServiceContext, type ResolvedConfiguration } from '../http-service';
import { fail, record } from '../moonraker-http';
import { copy, newId } from '../operations';
import { gcodeMetadataEndpoint, gcodeThumbnailPath, isRelativeFilePath, readGcodeThumbnail } from './file-thumbnail';

const internal = 'internal' as D.Id<'storage'>;
const usb = 'usb' as D.Id<'storage'>;
const collection = { id: 'gcode' as D.Id<'file-collection'>, name: 'G-code', kinds: ['print-file'], actions: [] } as const satisfies D.StorageCollection;
const filePrefix = 'snapmaker-storage:';
const mediaPrefix = 'snapmaker-thumbnail:';
const snapshotLifetimeMs = 5 * 60_000;

export const u1StorageCapabilities = {
  list: supported({ storageIds: [internal, usb], kinds: ['print-file'] }),
  preview: supported([{ storageId: internal, kinds: ['thumbnail'] }, { storageId: usb, kinds: ['thumbnail'] }]),
} satisfies Pick<D.FileCapabilities, 'list' | 'preview'>;

interface Snapshot {
  configurationRevision: D.Revision;
  revision: D.Revision;
  expiresAt: number;
  files: Record<string, D.RemoteFile[]>;
  thumbnails: Map<string, string | null>;
}

function isGcode(path: unknown): path is string {
  return isRelativeFilePath(path) && /\.(gcode|gco|g)$/i.test(path);
}

function storageFor(path: string): D.Id<'storage'> {
  return path.startsWith('.udisk/') ? usb : internal;
}

function storage(id: D.Id<'storage'>, availability: D.Availability): D.PrinterStorage {
  return {
    id, name: id === usb ? 'USB drive' : 'Internal', kind: id === usb ? 'removable' : 'internal',
    availability, capacityBytes: null, freeBytes: null,
    browsing: supported({ kind: 'collections', collections: [collection] }),
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

function inlineImage(bytes: Uint8Array, mimeType: string): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

export class U1Storage {
  private readonly snapshots = new Map<string, Snapshot>();
  constructor(private readonly context: HttpServiceContext) {}

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
    const target = this.context.targetFor(printer.id);
    const response = await this.context.http.getArray(printer, '/server/files/list?root=gcodes', signal);
    if (response.length > 20_000) fail('out-of-range', 'The printer reported more than 20,000 files.');
    const files: Snapshot['files'] = { [internal]: [], [usb]: [] };
    const seen = new Set<string>();
    for (const item of response) {
      const { path, size, modified } = record(item);
      if (!isGcode(path) || seen.has(path)) continue;
      seen.add(path);
      const storageId = storageFor(path);
      files[storageId].push({
        ref: { ...target, configurationRevision: entry.revision, storageId, fileId: `${filePrefix}${encodeURIComponent(path)}` as D.Id<'remote-file'> },
        directoryId: null, name: path.slice(path.lastIndexOf('/') + 1), mimeType: null,
        sizeBytes: typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : null,
        createdAtMs: null, modifiedAtMs: typeof modified === 'number' && Number.isFinite(new Date(modified * 1000).getTime()) ? modified * 1000 : null,
        metadata: { kind: 'print-file', format: 'gcode', estimatedDurationSeconds: null, materialKeys: null },
      });
    }
    await this.verify(target, entry.revision, signal);
    const snapshot = { configurationRevision: entry.revision, revision: newId<'listing'>(), expiresAt: Date.now() + snapshotLifetimeMs, files, thumbnails: new Map() };
    this.snapshots.delete(printer.id);
    this.snapshots.set(printer.id, snapshot);
    if (this.snapshots.size > 4) this.snapshots.delete(this.snapshots.keys().next().value!);
    return snapshot;
  }

  readonly files: NonNullable<HttpServiceBehavior['files']> = {
    listStorages: (target, options) => safe(async () => {
      const snapshot = await this.scan(await this.context.resolve(target), readSignal(options));
      return [storage(internal, { kind: 'available' }), storage(usb, snapshot.files[usb].length
        ? { kind: 'available' }
        : { kind: 'unknown', reason: 'No USB G-code files were reported. Refresh after connecting a USB drive or adding files.' })];
    }),
    list: (request, options) => safe(async () => {
      const { target, storageId, location, cursor, kinds, pageSize = 100 } = request;
      if ((storageId !== internal && storageId !== usb) || location.kind !== 'collection' || location.collectionId !== collection.id)
        fail('invalid-target', 'Unknown U1 file collection.');
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500) fail('invalid-request', 'Invalid U1 file page size.');
      const signal = readSignal(options);
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
      const resolved = await this.resolveFile(file, signal);
      const path = await this.thumbnail(resolved, signal);
      return { file: copy(file), options: path ? [{ id: previewId(file), kind: 'thumbnail', label: 'Thumbnail', contentFormat: null }] : [] };
    }),
  };

  private async resolveFile(file: D.RemoteFileRef, signal: AbortSignal) {
    if (!file.configurationRevision || !file.fileId.startsWith(filePrefix)) fail('invalid-target', 'Invalid U1 file reference.');
    const target = { printerId: file.printerId, routeId: file.routeId, expectedConfigurationRevision: file.configurationRevision };
    const resolved = await this.context.resolve(target);
    checkRead(signal);
    let filename: string;
    try { filename = decodeURIComponent(file.fileId.slice(filePrefix.length)); }
    catch { fail('invalid-target', 'Invalid U1 file reference.'); }
    if (!isGcode(filename) || storageFor(filename) !== file.storageId) fail('invalid-target', 'Invalid U1 file path.');
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
    if (target.printerId !== file.printerId || target.routeId !== file.routeId ||
        (target.expectedConfigurationRevision !== undefined && target.expectedConfigurationRevision !== file.configurationRevision) ||
        source.previewId !== previewId(file)) fail('invalid-target', 'Invalid U1 file preview.');
    const signal = readSignal(options);
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
      presentation: { kind: 'image', mimeType, url: inlineImage(bytes, mimeType) },
      expiresAtMs: null, acceptsUserActivity: false,
    };
  });

  ownsMedia(ref: D.MediaRef): boolean { return ref.id.startsWith(mediaPrefix); }
}
