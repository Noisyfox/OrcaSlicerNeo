import type { PrinterConfiguration } from '../configuration';
import { fail, MoonrakerHttp, record } from '../moonraker-http';

export function isRelativeFilePath(path: unknown): path is string {
  return typeof path === 'string' && !/[\\\u0000\uD800-\uDFFF]/u.test(path) &&
    path.split('/').every(segment => segment && segment !== '.' && segment !== '..');
}

export function gcodeMetadataEndpoint(filename: string): string {
  return `/server/files/metadata?filename=${encodeURIComponent(filename)}`;
}

export function gcodeThumbnailPath(filename: string, metadata: Record<string, unknown>): string | undefined {
  const thumbnails = Array.isArray(metadata.thumbnails) ? metadata.thumbnails.map(record) : [];
  const thumbnail = thumbnails.filter(item => typeof item.relative_path === 'string' &&
    typeof item.width === 'number' && Number.isFinite(item.width) && item.width > 0 &&
    typeof item.height === 'number' && Number.isFinite(item.height) && item.height > 0)
    .sort((a, b) => Number(b.width) * Number(b.height) - Number(a.width) * Number(a.height))[0];
  if (!thumbnail) return;
  const path = [...filename.split('/').slice(0, -1), String(thumbnail.relative_path)].join('/');
  return isRelativeFilePath(path) ? path : undefined;
}

export async function readGcodeThumbnail(http: MoonrakerHttp, printer: PrinterConfiguration, path: string, signal?: AbortSignal) {
  const bytes = await http.getBytes(printer, `/server/files/gcodes/${path.split('/').map(encodeURIComponent).join('/')}`, signal);
  if (bytes.byteLength > 4 * 1024 * 1024) fail('out-of-range', 'Printer thumbnail is too large.');
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return { bytes, mimeType: 'image/png' } as const;
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { bytes, mimeType: 'image/jpeg' } as const;
  fail('preview-unavailable', 'Invalid printer thumbnail.');
}
