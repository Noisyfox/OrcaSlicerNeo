import type { PrinterConfiguration } from '../configuration';
import type * as D from '../domain';
import { fail } from '../moonraker-http';
import { isRelativeFilePath } from './file-thumbnail';

export const u1InternalStorage = 'internal' as D.Id<'storage'>;
export const u1UsbStorage = 'usb' as D.Id<'storage'>;
export const u1GcodePrefix = 'snapmaker-storage:';
export const u1TimelapsePrefix = 'snapmaker-timelapse:';

/** The desktop download host and the renderer resolve the same configured route. */
export async function u1StorageRouteDigest(printer: Readonly<PrinterConfiguration>): Promise<string> {
  const input = JSON.stringify([printer.id, printer.driverId, printer.apiBaseUrl, printer.apiKey, printer.consoleUrl]);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function u1FileId(prefix: string, digest: string, value: string): D.Id<'remote-file'> {
  return `${prefix}${digest}:${encodeURIComponent(value)}` as D.Id<'remote-file'>;
}

export function u1FilePayload(file: D.RemoteFileRef, prefix: string) {
  const separator = prefix.length + 64;
  const digest = file.fileId.slice(prefix.length, separator);
  if (!file.configurationRevision || !file.fileId.startsWith(prefix) || !/^[\da-f]{64}$/.test(digest) ||
      file.fileId[separator] !== ':') fail('invalid-target', 'Invalid U1 file reference.');
  try { return { digest, value: decodeURIComponent(file.fileId.slice(separator + 1)) }; }
  catch { fail('invalid-target', 'Invalid U1 file reference.'); }
}

export function isU1Gcode(path: unknown): path is string {
  return isRelativeFilePath(path) && /\.(gcode|gco|g)$/i.test(path);
}

export function u1GcodeStorage(path: string) {
  return path.startsWith('.udisk/') ? u1UsbStorage : u1InternalStorage;
}

export function u1GcodeRef(file: D.RemoteFileRef) {
  const { digest, value } = u1FilePayload(file, u1GcodePrefix);
  if (!isU1Gcode(value) || u1GcodeStorage(value) !== file.storageId) fail('invalid-target', 'Invalid U1 file path.');
  return { digest, filename: value };
}

export function u1GcodeEndpoint(filename: string): string {
  return `/server/files/gcodes/${filename.split('/').map(encodeURIComponent).join('/')}`;
}

export function u1TimelapseAsset(path: unknown, kind: 'video' | 'cover'): path is string {
  return typeof path === 'string' && path.length <= 4096 && path.startsWith('/files/camera/') &&
    isRelativeFilePath(path.slice('/files/camera/'.length)) && (kind === 'video' ? /\.mp4$/i : /\.(png|jpe?g)$/i).test(path);
}

export function u1TimelapseAssetEndpoint(path: string, kind: 'video' | 'cover'): string {
  if (!u1TimelapseAsset(path, kind)) fail('invalid-target', 'Invalid U1 timelapse asset.');
  return `/server${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function u1TimelapseRef(file: D.RemoteFileRef) {
  if (file.storageId !== u1InternalStorage) fail('invalid-target', 'Invalid U1 timelapse reference.');
  const { digest, value } = u1FilePayload(file, u1TimelapsePrefix);
  let parts: unknown;
  try { parts = JSON.parse(value); }
  catch { fail('invalid-target', 'Invalid U1 timelapse reference.'); }
  if (!Array.isArray(parts) || parts.length !== 3 || !isU1TimelapseIndex(parts[0]) ||
      !u1TimelapseAsset(parts[1], 'video') || (parts[2] !== null && !u1TimelapseAsset(parts[2], 'cover')))
    fail('invalid-target', 'Invalid U1 timelapse reference.');
  return { digest, dateIndex: parts[0], video: parts[1], cover: parts[2] as string | null };
}

export function isU1TimelapseIndex(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}
