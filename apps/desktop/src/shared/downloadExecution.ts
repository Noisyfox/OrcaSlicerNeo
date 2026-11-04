/** Private execution-host protocol. Never forwarded through the application preload. */
import type { DownloadProgress, DownloadResult } from '@orca/printer-control/downloads';
import type { RemoteFileRef } from '@orca/printer-control/domain';
import type { DownloadRecovery, SavedDownloadFile } from '../utility/downloadFiles';
import type { ManagedDownloadDestination } from '../utility/downloadExecutor';
import { isStorageFileRef } from './bambuStorage';
export interface DownloadExecutionInputs {
  'download.initialize': { root: string; parentPid: number };
  'download.run': { id: string; file: RemoteFileRef; destination: ManagedDownloadDestination };
  'download.cancel': { id: string };
}
export interface DownloadExecutionResults {
  'download.initialize': DownloadRecovery;
  'download.run': DownloadResult<SavedDownloadFile>;
  'download.cancel': null;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const text = (value: unknown, max = 32768): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
export function isDownloadExecutionRequest(method: string, input: Record<string, unknown>): boolean {
  if (method === 'download.initialize') return exact(input, ['root', 'parentPid']) && text(input.root) && Number.isSafeInteger(input.parentPid) && Number(input.parentPid) > 0;
  if (!text(input.id, 512)) return false;
  if (method === 'download.cancel') return exact(input, ['id']);
  if (method !== 'download.run' || !exact(input, ['id', 'file', 'destination']) || !isStorageFileRef(input.file) || !object(input.destination)) return false;
  const d = input.destination;
  return d.kind === 'directory' && exact(d, ['kind', 'directory']) && text(d.directory) ||
    d.kind === 'file' && exact(d, ['kind', 'path', 'overwriteConfirmed']) && text(d.path) && typeof d.overwriteConfirmed === 'boolean';
}
export function isDownloadProgress(value: unknown): value is DownloadProgress {
  return object(value) && exact(value, ['phase', 'writtenBytes', 'totalBytes', 'canCancel']) &&
    ['opening', 'transferring', 'finalizing'].includes(String(value.phase)) &&
    Number.isSafeInteger(value.writtenBytes) && Number(value.writtenBytes) >= 0 &&
    (value.totalBytes === null || Number.isSafeInteger(value.totalBytes) && Number(value.totalBytes) >= Number(value.writtenBytes)) &&
    value.canCancel === (value.phase !== 'finalizing');
}
