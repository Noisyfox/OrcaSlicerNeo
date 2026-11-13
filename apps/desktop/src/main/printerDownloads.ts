import { randomUUID } from 'node:crypto';
import type * as D from '@orca/platform-contract';
import { ManagedDownloadTasks } from '@orca/printer-control/download-tasks';
import { TransferQueue } from '@orca/printer-control/transfer-queue';
import type { DownloadProgress, DownloadResult } from '@orca/platform-contract';
import type { SavedDownloadFile } from '../utility/downloadFiles';
import type { ManagedDownloadDestination } from '../utility/downloadExecutor';
export interface DownloadBinding {
  resolve(file: D.RemoteFileRef): Promise<D.Result<{ physicalPrinterKey: string }>>;
  execute(file: D.RemoteFileRef, destination: ManagedDownloadDestination, signal: AbortSignal, progress: (value: DownloadProgress) => void): Promise<DownloadResult<SavedDownloadFile>>;
}
export interface DownloadHost {
  destination(files: readonly D.DownloadSelection[], choose: boolean): Promise<ManagedDownloadDestination | null>;
  directory(): Promise<{ label: string }>;
  chooseDirectory(): Promise<{ status: 'selected'; label: string; id: D.DownloadDirectorySelectionId } | { status: 'cancelled' }>;
  saveDirectory(id: D.DownloadDirectorySelectionId): Promise<null>;
  open(path: string): Promise<void>;
}
const fail = (code: D.ErrorCode, message: string): D.Result<never> => ({ ok: false, error: { code, message } });
/** One host registry and scheduler for every agent. Provider bindings never select destinations. */
export class DesktopPrinterDownloads implements D.PrinterDownloads {
  readonly capability = { kind: 'supported', constraints: {} } as const;
  readonly queue = new TransferQueue(2);
  private readonly tasks: ManagedDownloadTasks<SavedDownloadFile>;
  private readonly listeners = new Set<() => void>();
  private admission: Promise<unknown> = Promise.resolve();
  private closing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly bindings: readonly DownloadBinding[], private readonly host: DownloadHost) {
    this.tasks = new ManagedDownloadTasks(this.queue, randomUUID, () => this.changed(), receipt => receipt.cleanupPending ? 'Saved; temporary-file cleanup needs attention.' : null);
  }
  private changed() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined;
      for (const listener of this.listeners) { try { listener(); } catch { /* Isolate views. */ } }
    }, 100);
  }
  onChanged(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async list() { return { ok: true as const, value: this.tasks.list() }; }
  async resolvePhysical(file: D.RemoteFileRef): Promise<D.Result<{ physicalPrinterKey: string }>> {
    for (const binding of this.bindings) { const result = await binding.resolve(file); if (result.ok || result.error.code !== 'unsupported') return result; }
    return fail('unsupported', 'This printer has no file reader on this host.');
  }
  start(request: Parameters<D.PrinterDownloads['start']>[0]): ReturnType<D.PrinterDownloads['start']> {
    const selected = structuredClone(request);
    const work = this.admission.then(async () => {
      if (this.closing) return fail('busy', 'Downloads are closing.');
      if (!selected.files.length || selected.files.length > 500) return fail('invalid-request', 'Select between 1 and 500 files.');
      try {
        const resolved = [];
        for (const selection of selected.files) {
          let binding: DownloadBinding | undefined, key: string | undefined;
          for (const candidate of this.bindings) {
            const result = await candidate.resolve(selection.file);
            if (result.ok) { binding = candidate; key = result.value.physicalPrinterKey; break; }
            if (result.error.code !== 'unsupported') return result;
          }
          if (!binding || !key) return fail('unsupported', 'This printer does not provide managed downloads on this host.');
          resolved.push({ selection, binding, key });
        }
        const destination = await this.host.destination(selected.files, selected.destination === 'choose');
        if (!destination) return { ok: true as const, value: { status: 'cancelled' as const } };
        if (this.closing) return fail('busy', 'Downloads are closing.');
        const batch = this.tasks.enqueue(resolved.map(({ selection, binding, key }) => ({ ...selection, physicalPrinterKey: key,
          execute: (signal, progress) => binding.execute(selection.file, destination, signal, progress) })));
        return { ok: true as const, value: { status: 'queued' as const, ...batch } };
      } catch { return fail('device-failed', 'The download could not be queued. Check the destination and pending task count.'); }
    });
    this.admission = work.catch(() => undefined); return work;
  }
  async cancel(id: D.DownloadTaskId) { return this.tasks.cancel(id) ? { ok: true as const, value: null } : fail('invalid-request', 'This task can no longer be cancelled.'); }
  async retry(id: D.DownloadTaskId) { return this.tasks.retry(id) ? { ok: true as const, value: null } : fail('invalid-request', 'This task cannot be retried yet.'); }
  async continue(id: D.DownloadTaskId) { return this.tasks.continue(id) ? { ok: true as const, value: null } : fail('invalid-request', 'This task is not paused.'); }
  async open(id: D.DownloadTaskId) {
    const saved = this.tasks.saved(id); if (!saved) return fail('invalid-request', 'No completed download is available.');
    try { await this.host.open(saved.path); return { ok: true as const, value: null }; }
    catch { return fail('device-failed', 'The saved file could not be opened.'); }
  }
  async directory() {
    try { return { ok: true as const, value: await this.host.directory() }; }
    catch { return fail('device-failed', 'The download folder could not be read.'); }
  }
  async chooseDirectory() {
    try { return { ok: true as const, value: await this.host.chooseDirectory() }; }
    catch { return fail('device-failed', 'The download folder could not be selected.'); }
  }
  async saveDirectory(id: D.DownloadDirectorySelectionId) {
    try { return { ok: true as const, value: await this.host.saveDirectory(id) }; }
    catch { return fail('device-failed', 'The download folder could not be saved.'); }
  }
  hasUnfinished() { return this.tasks.hasUnfinished(); }
  async close() {
    this.closing = true; await this.admission; await this.tasks.close();
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.listeners.clear();
    return this.tasks.list().filter(task => task.warning || task.state === 'failed' && task.error?.code === 'transport');
  }
}
