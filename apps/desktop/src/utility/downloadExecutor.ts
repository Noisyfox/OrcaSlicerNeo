import { executeDownload } from '@orca/printer-control/downloads';
import type { DownloadProgress, DownloadResult, PrinterFiles, RemoteFileRef } from '@orca/platform-contract';
import { createDownloadFileSink, openDownloadJournal, type DownloadDestination, type DownloadJournal, type SavedDownloadFile } from './downloadFiles';

export type ManagedDownloadDestination = { kind: 'directory'; directory: string } | Extract<DownloadDestination, { kind: 'file' }>;
/** Composed inside a provider execution host; destination handling is not provider code. */
export class DownloadExecutor {
  private journal: Promise<DownloadJournal> | undefined;
  private jobs = new Map<string, { controller: AbortController; result: Promise<DownloadResult<SavedDownloadFile>> }>();
  private cancelled = new Set<string>();
  private closed = false;
  constructor(private readonly read: PrinterFiles['download'], private readonly maxChunkBytes: number,
    private readonly progress: (id: string, value: DownloadProgress) => void) {}

  async initialize(root: string, parentPid: number) {
    if (this.closed || this.journal) throw new Error('Download execution is already initialized or closed.');
    this.journal = openDownloadJournal(root, parentPid);
    return (await this.journal).recovery;
  }
  run(id: string, file: RemoteFileRef, destination: ManagedDownloadDestination): Promise<DownloadResult<SavedDownloadFile>> {
    if (this.closed || !this.journal || this.jobs.has(id)) return Promise.resolve({ status: 'failed', writtenBytes: 0,
      failure: { stage: 'open', cleanupFailed: false, error: { code: 'invalid-request', message: 'Download execution is unavailable.' } } });
    const controller = new AbortController();
    const admittedFile = { ...file }, admittedDestination = { ...destination };
    if (this.cancelled.has(id)) controller.abort();
    const result = (async () => {
      const journal = await this.journal!;
      return executeDownload(admittedFile, { read: this.read, maxChunkBytes: this.maxChunkBytes,
        createSink: metadata => createDownloadFileSink(admittedDestination.kind === 'directory'
          ? { ...admittedDestination, fileName: metadata.suggestedFileName } : admittedDestination, journal.directory),
      }, { signal: controller.signal, progress: value => this.progress(id, value) });
    })().finally(() => this.jobs.delete(id));
    this.jobs.set(id, { controller, result }); return result;
  }
  cancel(id: string): void {
    this.cancelled.add(id); this.jobs.get(id)?.controller.abort();
    while (this.cancelled.size > 128) this.cancelled.delete(this.cancelled.values().next().value!);
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map(job => job.result));
    if (this.journal) await (await this.journal).close();
  }
}
