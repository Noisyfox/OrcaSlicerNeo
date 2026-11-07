import type { PrinterDownloads } from '@orca/printer-control/domain';
import { isStorageFileRef } from './bambuStorage';
export type DownloadMethod = Exclude<keyof PrinterDownloads, 'capability' | 'onChanged'>;
export type DownloadRequest = { [K in DownloadMethod]: { method: K; args: Parameters<PrinterDownloads[K]> } }[DownloadMethod];
export type DownloadReply<K extends DownloadMethod> = Awaited<ReturnType<PrinterDownloads[K]>>;
export function isDownloadRequest(value: unknown): value is DownloadRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['method', 'args'].includes(key))) return false;
  const { method, args } = value as DownloadRequest;
  if (!Array.isArray(args)) return false;
  if (['list', 'directory', 'chooseDirectory'].includes(method)) return args.length === 0;
  if (['cancel', 'retry', 'continue', 'open', 'saveDirectory'].includes(method)) return args.length === 1 && typeof args[0] === 'string' && args[0].length > 0 && args[0].length <= 512;
  if (method !== 'start' || args.length !== 1 || !args[0] || typeof args[0] !== 'object') return false;
  const request = args[0];
  return Object.keys(request).every(key => ['files', 'destination'].includes(key)) && ['default', 'choose'].includes(request.destination) &&
    Array.isArray(request.files) && request.files.length > 0 && request.files.length <= 500 && request.files.every(selection =>
      selection && typeof selection === 'object' && Object.keys(selection).every(key => ['file', 'name', 'printerName'].includes(key)) &&
      isStorageFileRef(selection.file) && typeof selection.name === 'string' && selection.name.length > 0 && selection.name.length <= 4096 &&
      typeof selection.printerName === 'string' && selection.printerName.length <= 512);
}
