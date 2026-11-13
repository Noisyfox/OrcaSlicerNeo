/** Host-owned save tasks. Task snapshots contain no local paths, credentials, native handles or byte buffers. */
import type { Capability, Id, NoConstraints, PrinterError, Result } from './common';
import type { DownloadedFile, PrinterFiles, RemoteFileRef } from './files';
export type DownloadTaskId = Id<'download-task'>;
export type DownloadBatchId = Id<'download-batch'>;
export type DownloadDirectorySelectionId = Id<'download-directory-selection'>;
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
  /** Application-wide setting shared by all agents, presented in Preferences.
   * Desktop labels show the full current directory path as display-only metadata.
   * Filesystem operations use host-owned selections, never this label. */
  directory(): Promise<Result<{ label: string }>>;
  /** Choose a draft location without changing the configured directory. */
  chooseDirectory(): Promise<Result<{ status: 'selected'; label: string; id: DownloadDirectorySelectionId } | { status: 'cancelled' }>>;
  /** Commit an opaque selection issued by this host; never accepts a filesystem path. */
  saveDirectory(id: DownloadDirectorySelectionId): Promise<Result<null>>;
}

export interface DownloadProgress {
  phase: 'opening' | 'transferring' | 'finalizing';
  writtenBytes: number;
  totalBytes: number | null;
  canCancel: boolean;
}

/** The host owns temporary output. Each write must settle before cleanup can remove it. */
export interface DownloadSink<T> {
  write(chunk: Uint8Array): Promise<void>;
  /** Publication is the commit point: cancellation cannot undo a successful publication. */
  publish(): Promise<T>;
  /** Close and remove only this attempt's unpublished output; safe after a failed publish. */
  discard(): Promise<void>;
}

export type DownloadFailureStage = 'open' | 'read' | 'write' | 'validate' | 'publish' | 'cleanup';
export interface DownloadFailure {
  stage: DownloadFailureStage;
  error: PrinterError;
  /** Cleanup errors take precedence over a nominal cancellation. */
  cleanupFailed: boolean;
}
export type DownloadResult<T> = { status: 'saved'; value: T; writtenBytes: number }
  | { status: 'cancelled'; writtenBytes: number }
  | { status: 'failed'; writtenBytes: number; failure: DownloadFailure };

export interface DownloadExecution<T> {
  read: PrinterFiles['download'];
  /** A rejected open cleans any output it created before rejecting. */
  createSink(file: Pick<DownloadedFile, 'suggestedFileName' | 'mimeType' | 'totalBytes'>): Promise<DownloadSink<T>>;
  /** Host budget, also enforced at the provider/native transport boundary. */
  maxChunkBytes: number;
}

export interface ManagedDownloadRequest<T> extends DownloadSelection {
  physicalPrinterKey: string;
  /** Each attempt revalidates the source and opens fresh output starting at byte zero. */
  execute(signal: AbortSignal, progress: (value: DownloadProgress) => void): Promise<DownloadResult<T>>;
}

export type TransferCompletion = { status: 'finished' } | { status: 'blocked'; reason: PrinterError };
export interface TransferSnapshot {
  state: 'waiting' | 'running' | 'stopping' | 'blocked' | 'finished';
  attempt: number;
  reason: PrinterError | null;
}
export interface TransferTicket {
  snapshot(): TransferSnapshot;
  /** Resolves only once remote reads and cleanup have joined, or waiting work was removed. */
  finished: Promise<void>;
  cancel(): void;
  /** Retry the blocked head in place with a new attempt. Later work cannot pass it. */
  retry(): boolean;
  /** Acknowledge the blocked result and continue later work without retrying it. */
  continue(): boolean;
}
export interface TransferRequest {
  /** Validated host-resolved physical identity, never a route ID or UI selection. */
  physicalPrinterKey: string;
  run(context: { signal: AbortSignal; attempt: number }): Promise<TransferCompletion>;
  changed?(snapshot: TransferSnapshot): void;
}
