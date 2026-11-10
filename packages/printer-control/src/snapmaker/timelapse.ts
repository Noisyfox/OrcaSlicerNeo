import type { PrinterConfiguration } from '../configuration';
import type * as D from '../domain';
import { safe, type HttpServiceContext } from '../http-service';
import { endpoint, fail, MoonrakerFailure, record } from '../moonraker-http';
import { copy } from '../operations';
import { U1CameraControl, type U1CameraControlOptions } from './camera-protocol';
import { inlineThumbnail, readThumbnail } from './file-thumbnail';
import { isU1TimelapseIndex, u1FileId, u1InternalStorage as internal, u1StorageRouteDigest, u1TimelapseAsset as assetPath,
  u1TimelapseAssetEndpoint, u1TimelapsePrefix as filePrefix, u1TimelapseRef } from './file-reference';

export const u1TimelapseCollectionId = 'timelapse' as D.Id<'file-collection'>;
const mediaPrefix = 'snapmaker-timelapse-media:';

interface TimelapseEntry {
  dateIndex: string;
  name: string;
  video: string;
  cover: string | null;
  bytes: number | null;
  duration: number | null;
  modified: number | null;
}

export interface U1TimelapsePage {
  entries: TimelapseEntry[];
  total: number;
}

export interface U1TimelapseTransport {
  list(printer: Readonly<PrinterConfiguration>, page: number, rows: number, signal: AbortSignal): Promise<U1TimelapsePage>;
  canPlay(printer: Readonly<PrinterConfiguration>): boolean;
  open(printer: Readonly<PrinterConfiguration>, video: string, signal: AbortSignal): Promise<{ url: string; close?: () => Promise<void> }>;
  delete(printer: Readonly<PrinterConfiguration>, dateIndex: string, signal: AbortSignal): Promise<D.Result<null>>;
}

function durationSeconds(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+:\d{2}(?::\d{2})?$/.test(value)) return null;
  const seconds = value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

export function u1TimelapseVideoUrl(printer: Pick<PrinterConfiguration, 'apiBaseUrl'>, path: string): string {
  return endpoint(printer.apiBaseUrl, u1TimelapseAssetEndpoint(path, 'video'));
}

export async function readU1TimelapsePage(printer: Pick<PrinterConfiguration, 'apiBaseUrl' | 'apiKey'>, page: number, rows: number,
  options: Pick<U1CameraControlOptions, 'http' | 'sockets'>, signal: AbortSignal): Promise<U1TimelapsePage> {
  const control = await U1CameraControl.connect(printer, { ...options, signal, clientId: crypto.randomUUID() });
  try {
    const { instances, total_count: total, page_index: returnedPage } = await control.listTimelapses(page, rows, signal);
    if (!Array.isArray(instances) || instances.length > rows || !Number.isSafeInteger(total) || Number(total) < 0 || returnedPage !== page)
      fail('device-failed', 'Invalid U1 timelapse listing.');
    const entries: TimelapseEntry[] = [];
    for (const value of instances) {
      const item = record(value), video = item.video_local_url_suffix;
      if (!assetPath(video, 'video') || !isU1TimelapseIndex(item.date_index)) continue;
      const name = typeof item.gcode_name === 'string' && item.gcode_name ? item.gcode_name : video.slice(video.lastIndexOf('/') + 1);
      const stamp = typeof item.unix_timestamp_s === 'number' ? item.unix_timestamp_s * 1000 : NaN;
      const cover = item.cover_local_url_suffix;
      entries.push({ dateIndex: item.date_index, name, video, cover: assetPath(cover, 'cover') ? cover : null,
        bytes: Number.isSafeInteger(item.video_file_size) && Number(item.video_file_size) > 0 ? Number(item.video_file_size) : null,
        duration: durationSeconds(item.video_duration), modified: Number.isFinite(new Date(stamp).getTime()) ? stamp : null });
    }
    return { entries, total: Number(total) };
  } finally { control.close(); }
}

export function deleteU1Timelapse(printer: Pick<PrinterConfiguration, 'apiBaseUrl' | 'apiKey'>, dateIndex: string,
  options: Pick<U1CameraControlOptions, 'http' | 'sockets'>, signal: AbortSignal): Promise<D.Result<null>> {
  return safe(async () => {
    if (!/^\d{14}$/.test(dateIndex)) fail('invalid-request', 'Invalid U1 timelapse index.');
    const control = await U1CameraControl.connect(printer, { ...options, signal, clientId: crypto.randomUUID() });
    try { await control.deleteTimelapse(dateIndex, signal); return null; }
    finally { control.close(); }
  });
}

function optionId(file: D.RemoteFileRef, kind: 'thumbnail' | 'video'): D.Id<'preview-option'> {
  return `${file.fileId}:${kind}` as D.Id<'preview-option'>;
}

export class U1Timelapses {
  private readonly leases = new Map<string, () => Promise<void>>();
  constructor(private readonly context: HttpServiceContext, private readonly transport: U1TimelapseTransport) {}

  collection(printer: Readonly<PrinterConfiguration>): D.StorageCollection {
    return { id: u1TimelapseCollectionId, name: 'Timelapse', kinds: ['timelapse'],
      actions: this.transport.canPlay(printer) ? ['download', 'delete', 'preview'] : ['download', 'delete'] };
  }

  ownsFile(file: D.RemoteFileRef): boolean { return file.fileId.startsWith(filePrefix); }
  ownsMedia(ref: D.MediaRef): boolean { return ref.id.startsWith(mediaPrefix); }

  async list(request: D.ListFilesRequest, signal: AbortSignal): Promise<D.RemoteFilePage> {
    if (request.storageId !== internal) fail('invalid-target', 'Timelapses are stored internally.');
    const { printer, entry } = await this.context.resolve(request.target);
    const pageSize = request.pageSize ?? 20;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) fail('invalid-request', 'Invalid U1 timelapse page size.');
    const rows = Math.min(pageSize, 20);
    const empty = { directories: [], files: [], nextCursor: null, listingRevision: null, pagination: 'best-effort' } as const;
    if (request.kinds && !request.kinds.includes('timelapse')) return empty;
    const prefix = `${entry.revision}:${rows}:`;
    const page = request.cursor === undefined ? 1 : Number(request.cursor.slice(prefix.length));
    if (request.cursor !== undefined && (!request.cursor.startsWith(prefix) || !Number.isSafeInteger(page) || page < 2))
      fail('listing-expired', 'This timelapse list has changed. Refresh Storage.');
    const result = await this.transport.list(printer, page, rows, signal);
    const digest = await u1StorageRouteDigest(printer);
    await this.verify(request.target, entry.revision, signal);
    const files: D.RemoteFile[] = result.entries.map(item => ({
      ref: { ...this.context.targetFor(printer.id), storageId: internal, configurationRevision: entry.revision,
        fileId: u1FileId(filePrefix, digest, JSON.stringify([item.dateIndex, item.video, item.cover])) },
      directoryId: null, name: /\.mp4$/i.test(item.name) ? item.name : `${item.name.replace(/\.(gcode|gco|g)$/i, '')}.mp4`,
      mimeType: 'video/mp4', sizeBytes: item.bytes, createdAtMs: null, modifiedAtMs: item.modified,
      metadata: { kind: 'timelapse', durationSeconds: item.duration, width: null, height: null },
    }));
    return { ...empty, files, nextCursor: page * rows < result.total ? `${prefix}${page + 1}` : null };
  }

  private async resolve(file: D.RemoteFileRef, signal: AbortSignal) {
    const { video, cover } = u1TimelapseRef(file);
    const { printer } = await this.context.resolve({ ...file, expectedConfigurationRevision: file.configurationRevision });
    if (signal.aborted) fail('cancelled', 'Timelapse request cancelled.');
    return { printer, video, cover };
  }

  private async verify(target: D.PrinterTarget, revision: D.Revision, signal: AbortSignal) {
    await this.context.resolve({ ...target, expectedConfigurationRevision: revision });
    if (signal.aborted) fail('cancelled', 'Timelapse request cancelled.');
  }

  async delete(file: D.RemoteFileRef, signal: AbortSignal): Promise<void> {
    const { digest, dateIndex } = u1TimelapseRef(file);
    if (!/^\d{14}$/.test(dateIndex)) fail('invalid-target', 'This timelapse does not have a supported deletion identity.');
    const { printer } = await this.context.resolve({ ...file, expectedConfigurationRevision: file.configurationRevision });
    if (digest !== await u1StorageRouteDigest(printer)) fail('stale-context', 'The printer configuration changed. Refresh Storage.');
    await this.verify(file, file.configurationRevision, signal);
    let result: D.Result<null>;
    try { result = await this.transport.delete(printer, dateIndex, signal); }
    catch { throw new MoonrakerFailure({ code: 'transport', message: 'Timelapse deletion response was interrupted.' }, true); }
    if (!result.ok) {
      // The firmware proxy can report failure after a lost reply. Never retry it.
      const uncertain = !['unsupported', 'authentication-required', 'permission-denied', 'stale-context'].includes(result.error.code);
      throw new MoonrakerFailure(result.error, uncertain);
    }
  }

  async previews(file: D.RemoteFileRef, signal: AbortSignal): Promise<D.FilePreviewListing> {
    const { printer, cover } = await this.resolve(file, signal);
    const options: D.FilePreviewOption[] = [];
    if (cover) options.push({ id: optionId(file, 'thumbnail'), kind: 'thumbnail', label: 'Thumbnail', contentFormat: null });
    if (this.transport.canPlay(printer)) options.push({ id: optionId(file, 'video'), kind: 'video', label: 'Video', contentFormat: null });
    return { file: copy(file), options };
  }

  async open(request: D.OpenMediaRequest & { source: Extract<D.MediaSource, { kind: 'file-preview' }> }, signal: AbortSignal): Promise<D.MediaDescriptor> {
    const { source, target, requestId, client } = request, file = source.target;
    if (target.printerId !== file.printerId || target.routeId !== file.routeId ||
      (target.expectedConfigurationRevision !== undefined && target.expectedConfigurationRevision !== file.configurationRevision))
      fail('invalid-target', 'Invalid U1 timelapse target.');
    const { printer, cover, video } = await this.resolve(file, signal);
    const ref = { printerId: file.printerId, routeId: file.routeId, id: `${mediaPrefix}${requestId}` as D.Id<'media'> };
    const descriptor = { ref, configurationRevision: file.configurationRevision, revision: 1, source: copy(source), expiresAtMs: null, acceptsUserActivity: false };
    if (source.previewId === optionId(file, 'thumbnail') && cover) {
      const { bytes, mimeType } = await readThumbnail(this.context.http, printer, u1TimelapseAssetEndpoint(cover, 'cover'), signal);
      await this.verify(target, file.configurationRevision, signal);
      if (!client.imageMimeTypes.includes(mimeType)) fail('no-compatible-media', 'The client cannot display this thumbnail.');
      return { ...descriptor, presentation: { kind: 'image', mimeType, url: inlineThumbnail(bytes, mimeType) } };
    }
    if (source.previewId !== optionId(file, 'video')) fail('invalid-target', 'Unknown U1 timelapse preview.');
    if (!this.transport.canPlay(printer) || !client.video.some(item => item.transport === 'progressive-http' && item.codecIds.includes('h264')))
      fail('no-compatible-media', 'This host cannot play the U1 timelapse.');
    const opened = await this.transport.open(printer, video, signal);
    try {
      await this.verify(target, file.configurationRevision, signal);
      await this.close(ref);
      if (opened.close) this.leases.set(this.leaseKey(ref), opened.close);
      return { ...descriptor, presentation: { kind: 'video', delivery: { transport: 'progressive-http', url: opened.url,
        mimeType: 'video/mp4', credentials: 'same-origin' }, profile: null, durationSeconds: null, seekable: true, codecId: 'h264', live: false } };
    } catch (error) {
      await opened.close?.();
      throw error;
    }
  }

  private leaseKey(ref: D.MediaRef): string { return JSON.stringify([ref.printerId, ref.routeId, ref.id]); }
  async close(ref: D.MediaRef): Promise<null> {
    const key = this.leaseKey(ref), close = this.leases.get(key);
    this.leases.delete(key);
    await close?.();
    return null;
  }
}
