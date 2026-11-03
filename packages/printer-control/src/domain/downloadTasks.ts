/** Host-owned save tasks. No local paths, credentials, native handles or byte buffers. */
import type { Capability, Id, NoConstraints, PrinterError, Result } from './common';
import type { RemoteFileRef } from './files';
export type DownloadTaskId = Id<'download-task'>;
export type DownloadBatchId = Id<'download-batch'>;
export interface DownloadSelection { file: RemoteFileRef; name: string; printerName: string }
export interface DownloadTaskSnapshot extends DownloadSelection {
  id: DownloadTaskId;
  batchId: DownloadBatchId;
  attempt: number;
  state: 'waiting' | 'running' | 'paused' | 'saved' | 'handed-to-browser' | 'failed' | 'cancelled';
  phase: 'opening' | 'transferring' | 'finalizing' | null;
  writtenBytes: number;
  totalBytes: number | null;
  canCancel: boolean;
  canRetry: boolean;
  error: PrinterError | null;
  warning: string | null;
}
export interface PrinterDownloads {
  capability: Capability<NoConstraints>;
  start(request: { files: readonly DownloadSelection[]; destination: 'default' | 'choose' }): Promise<Result<
    { status: 'queued'; batchId: DownloadBatchId; taskIds: readonly DownloadTaskId[] } | { status: 'cancelled' }>>;
  list(): Promise<Result<readonly DownloadTaskSnapshot[]>>;
  onChanged(listener: () => void): () => void;
  cancel(id: DownloadTaskId): Promise<Result<null>>;
  retry(id: DownloadTaskId): Promise<Result<null>>;
  /** Acknowledge a blocked file failure and permit later queued work. */
  continue(id: DownloadTaskId): Promise<Result<null>>;
  open(id: DownloadTaskId): Promise<Result<null>>;
  /** Display label only. The configured filesystem location stays host-private. */
  directory(): Promise<Result<{ label: string }>>;
  chooseDirectory(): Promise<Result<{ status: 'selected'; label: string } | { status: 'cancelled' }>>;
}
