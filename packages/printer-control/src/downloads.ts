/** Host-neutral managed saving. Readers never receive a destination or filesystem path. */
import type { DownloadedFile, PrinterError, PrinterFiles, RemoteFileRef } from './domain';

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

class ReadFailure extends Error {
  constructor(readonly detail: PrinterError) { super(detail.message); }
}
const cancelled = () => new ReadFailure({ code: 'cancelled', message: 'Download cancelled.' });
function invalid(message: string): never {
  throw new ReadFailure({ code: 'invalid-request', message });
}
function count(value: number | null): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) invalid('Invalid download byte count.');
}
function sameFile(a: RemoteFileRef, b: RemoteFileRef): boolean {
  return a.printerId === b.printerId && a.routeId === b.routeId &&
    a.configurationRevision === b.configurationRevision && a.storageId === b.storageId && a.fileId === b.fileId;
}
function failureOf(error: unknown, stage: DownloadFailureStage): PrinterError {
  // Provider detail is already the public domain error. Never expose arbitrary host errors/paths.
  if (error instanceof Error && 'detail' in error) {
    const detail = error.detail as PrinterError | undefined;
    if (detail && typeof detail.code === 'string' && typeof detail.message === 'string') return detail;
  }
  return { code: 'device-failed', message: `Download ${stage} failed.` };
}

/**
 * Saves one complete file with one outstanding chunk/write, without buffering the file.
 * Reader opening and pending next() must honor their AbortSignal. Iterator return must
 * join resource release; sink writes/publication settle before any discard is attempted.
 */
export async function executeDownload<T>(
  target: RemoteFileRef, execution: DownloadExecution<T>,
  options: { signal?: AbortSignal; progress?: (value: DownloadProgress) => void } = {},
): Promise<DownloadResult<T>> {
  const source = { ...target };
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  let iterator: AsyncIterator<Uint8Array> | undefined;
  let sink: DownloadSink<T> | undefined;
  let writtenBytes = 0, totalBytes: number | null = null;
  let stage: DownloadFailureStage = 'open';
  const checkCancelled = () => { if (controller.signal.aborted) throw cancelled(); };
  const progress = (phase: DownloadProgress['phase']) => {
    try { options.progress?.({ phase, writtenBytes, totalBytes, canCancel: phase !== 'finalizing' }); }
    catch { /* A view cannot break transfer ownership or cleanup. */ }
  };
  try {
    if (!Number.isSafeInteger(execution.maxChunkBytes) || execution.maxChunkBytes <= 0) invalid('Invalid download buffer budget.');
    checkCancelled();
    progress('opening');
    checkCancelled();
    const result = await execution.read({ target: source }, { signal: controller.signal });
    if (!result.ok) throw new ReadFailure(result.error);
    const read = result.value;
    iterator = read.chunks[Symbol.asyncIterator]();
    checkCancelled();
    stage = 'validate';
    if (!sameFile(source, read.file)) throw new ReadFailure({ code: 'invalid-target', message: 'Download source does not match the selected file.' });
    count(read.totalBytes); count(read.responseBytes);
    if (read.totalBytes !== null && read.responseBytes !== null && read.totalBytes !== read.responseBytes) invalid('Download did not return a complete file.');
    if (read.returnedRange !== null && (read.totalBytes === null || read.returnedRange.startByte !== 0 || read.returnedRange.endByteExclusive !== read.totalBytes)) invalid('Download returned a partial file.');
    totalBytes = read.totalBytes ?? read.responseBytes;
    stage = 'open';
    sink = await execution.createSink({ suggestedFileName: read.suggestedFileName, mimeType: read.mimeType, totalBytes });
    checkCancelled();
    progress('transferring');
    while (true) {
      checkCancelled();
      stage = 'read';
      const next = await iterator.next();
      checkCancelled();
      if (next.done) break; // The reader's terminal integrity check must also succeed.
      stage = 'validate';
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > execution.maxChunkBytes) invalid('Download chunk exceeds the host buffer budget.');
      const nextSize = writtenBytes + chunk.byteLength;
      if (!Number.isSafeInteger(nextSize) || (totalBytes !== null && nextSize > totalBytes)) invalid('Download exceeds its declared length.');
      if (chunk.byteLength === 0) continue;
      stage = 'write';
      await sink.write(chunk);
      writtenBytes = nextSize;
      checkCancelled();
      progress('transferring');
    }
    stage = 'validate';
    if (totalBytes !== null && writtenBytes !== totalBytes) invalid('Download ended before its declared length.');
    stage = 'read';
    await iterator.return?.();
    iterator = undefined;
    checkCancelled();
    stage = 'publish';
    progress('finalizing');
    // A cancellation requested before publication is still honored. Once publish
    // starts, the host must resolve its real outcome instead of racing cancellation.
    checkCancelled();
    const value = await sink.publish();
    return { status: 'saved', value, writtenBytes };
  } catch (error) {
    const primary = failureOf(error, stage);
    controller.abort();
    let cleanupFailed = false;
    try { await iterator?.return?.(); } catch { cleanupFailed = true; }
    try { await sink?.discard(); } catch { cleanupFailed = true; }
    if (cleanupFailed) return { status: 'failed', writtenBytes, failure: {
      stage: 'cleanup', error: { code: 'device-failed', message: 'Download stopped, but resource cleanup failed.' }, cleanupFailed: true,
    } };
    if (primary.code === 'cancelled' || (options.signal?.aborted && stage !== 'publish')) return { status: 'cancelled', writtenBytes };
    return { status: 'failed', writtenBytes, failure: { stage, error: primary, cleanupFailed: false } };
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}
