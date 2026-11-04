import type { DownloadBatchId, DownloadSelection, DownloadTaskId, DownloadTaskSnapshot } from './domain';
import type { DownloadProgress, DownloadResult } from './downloads';
import { TransferQueue, type TransferTicket } from './transferQueue';

export interface ManagedDownloadRequest<T> extends DownloadSelection {
  physicalPrinterKey: string;
  /** Each attempt revalidates the source and opens fresh output starting at byte zero. */
  execute(signal: AbortSignal, progress: (value: DownloadProgress) => void): Promise<DownloadResult<T>>;
}
interface Task<T> { snapshot: DownloadTaskSnapshot; request: ManagedDownloadRequest<T>; ticket?: TransferTicket; result?: T; active?: object }
const terminal = (value: DownloadTaskSnapshot) => ['saved', 'failed', 'cancelled', 'handed-to-browser'].includes(value.state);
export function pausesDownloadQueue(result: Extract<DownloadResult<unknown>, { status: 'failed' }>): boolean {
  return result.failure.cleanupFailed || ['offline', 'transport', 'authentication-required', 'storage-unavailable'].includes(result.failure.error.code) ||
    ['open', 'write', 'publish'].includes(result.failure.stage) && result.failure.error.code === 'permission-denied';
}

/** Task semantics are independent of the process that executes reading and saving. */
export class ManagedDownloadTasks<T> {
  private tasks = new Map<DownloadTaskId, Task<T>>();
  private closed = false;
  private notificationScheduled = false;
  constructor(private readonly queue: TransferQueue, private readonly newId: () => string,
    private readonly changed: () => void, private readonly savedWarning: (value: T) => string | null = () => null) {}

  enqueue(requests: readonly ManagedDownloadRequest<T>[]): { batchId: DownloadBatchId; taskIds: DownloadTaskId[] } {
    if (this.closed) throw new Error('Download admission is closed.');
    if (!requests.length || requests.length > 500 || [...this.tasks.values()].filter(task => !terminal(task.snapshot)).length + requests.length > 1000)
      throw new Error('Too many pending download tasks.');
    if (requests.some(request => !request.physicalPrinterKey)) throw new Error('Physical printer identity is required.');
    const batchId = this.newId() as DownloadBatchId;
    const ids = requests.map(() => this.newId() as DownloadTaskId);
    if (new Set(ids).size !== ids.length || ids.some(id => this.tasks.has(id))) throw new Error('Download task identity collision.');
    for (const [index, original] of requests.entries()) {
      const request = { ...original, file: { ...original.file } }, id = ids[index];
      const task: Task<T> = { request, snapshot: { id, batchId, file: { ...request.file }, name: request.name, printerName: request.printerName,
        attempt: 0, state: 'waiting', phase: null, writtenBytes: 0, totalBytes: null, canCancel: true, canRetry: false, error: null, warning: null } };
      this.tasks.set(id, task); this.admit(task);
    }
    this.prune(); this.publish(); return { batchId, taskIds: ids };
  }

  list(): readonly DownloadTaskSnapshot[] { return [...this.tasks.values()].map(task => structuredClone(task.snapshot)); }
  saved(id: DownloadTaskId): T | undefined { const task = this.tasks.get(id); return task?.snapshot.state === 'saved' ? task.result : undefined; }
  hasUnfinished(): boolean { return [...this.tasks.values()].some(task => !terminal(task.snapshot)); }
  cancel(id: DownloadTaskId): boolean {
    const task = this.tasks.get(id); if (!task?.snapshot.canCancel) return false;
    if (task.snapshot.state === 'waiting' || task.snapshot.state === 'paused') {
      task.snapshot.state = 'cancelled'; task.snapshot.phase = null; task.snapshot.canRetry = true;
    }
    task.snapshot.canCancel = false; task.ticket?.cancel(); this.publish(); return true;
  }
  retry(id: DownloadTaskId): boolean {
    const task = this.tasks.get(id); if (this.closed || !task?.snapshot.canRetry) return false;
    if (task.snapshot.state === 'paused') {
      if (task.ticket?.snapshot().state !== 'blocked') return false;
      task.snapshot.state = 'waiting'; task.snapshot.phase = null; task.snapshot.canRetry = false; task.snapshot.canCancel = true;
      task.snapshot.error = null; task.snapshot.writtenBytes = 0; task.snapshot.totalBytes = null;
      if (!task.ticket?.retry()) return false;
    } else {
      task.snapshot = { ...task.snapshot, state: 'waiting', phase: null, canRetry: false, canCancel: true, error: null, warning: null, writtenBytes: 0, totalBytes: null };
      this.admit(task);
    }
    this.publish(); return true;
  }
  continue(id: DownloadTaskId): boolean {
    const task = this.tasks.get(id); if (!task || task.snapshot.state !== 'paused' || task.ticket?.snapshot().state !== 'blocked') return false;
    task.snapshot.state = 'failed'; task.snapshot.canCancel = false;
    const resumed = task.ticket?.continue() ?? false; this.publish(); return resumed;
  }

  private admit(task: Task<T>): void {
    task.ticket = this.queue.enqueue({ physicalPrinterKey: task.request.physicalPrinterKey,
      changed: state => {
        // A queued cancellation/closed scheduler never opens an executor.
        if (state.state === 'finished' && task.snapshot.state === 'waiting') {
          task.snapshot.state = 'cancelled'; task.snapshot.canCancel = false; task.snapshot.canRetry = true;
        }
        this.publish();
      },
      run: async ({ signal }) => {
        const active = {}; task.active = active;
        task.snapshot = { ...task.snapshot, state: 'running', phase: 'opening', writtenBytes: 0, totalBytes: null,
          attempt: task.snapshot.attempt + 1, error: null, warning: null, canCancel: true, canRetry: false };
        this.publish();
        let result: DownloadResult<T>;
        try {
          result = await task.request.execute(signal, progress => {
            if (task.active !== active) return;
            task.snapshot = { ...task.snapshot, phase: progress.phase, writtenBytes: progress.writtenBytes,
              totalBytes: progress.totalBytes, canCancel: progress.canCancel && !signal.aborted };
            this.publish();
          });
        } catch {
          result = { status: 'failed', writtenBytes: task.snapshot.writtenBytes, failure: { stage: 'cleanup', cleanupFailed: true,
            error: { code: 'transport', message: 'The download executor stopped without confirming cleanup.' } } };
        }
        task.active = undefined;
        task.snapshot.writtenBytes = result.writtenBytes; task.snapshot.phase = null; task.snapshot.canCancel = false;
        if (result.status === 'saved') {
          task.result = result.value; task.snapshot.state = 'saved';
          try { task.snapshot.warning = this.savedWarning(result.value); }
          catch { task.snapshot.warning = 'The file was saved, but its cleanup status could not be checked.'; }
        } else if (result.status === 'cancelled') {
          task.snapshot.state = 'cancelled'; task.snapshot.canRetry = true;
        } else {
          if (result.failure.cleanupFailed) task.snapshot.warning = 'Temporary-file cleanup could not be confirmed.';
          task.snapshot.error = { ...result.failure.error }; task.snapshot.canRetry = true;
          if (!signal.aborted && !this.closed && pausesDownloadQueue(result)) {
            task.snapshot.state = 'paused'; task.snapshot.canCancel = true; this.publish();
            return { status: 'blocked', reason: result.failure.error };
          }
          task.snapshot.state = 'failed';
        }
        this.prune(); this.publish(); return { status: 'finished' };
      },
    });
  }
  private publish(): void {
    if (this.notificationScheduled) return;
    this.notificationScheduled = true;
    queueMicrotask(() => { this.notificationScheduled = false;
      try { this.changed(); } catch { /* Observers do not own execution. */ }
    });
  }
  private prune(): void {
    const completed = [...this.tasks].filter(([, task]) => terminal(task.snapshot));
    for (const [id] of completed.slice(0, Math.max(0, completed.length - 200))) this.tasks.delete(id);
  }
  /** Called by a host-wide shutdown that also owns the shared download/playback queue. */
  async close(): Promise<void> {
    this.closed = true;
    for (const task of this.tasks.values()) if (task.snapshot.state === 'paused') {
      task.snapshot.state = 'failed'; task.snapshot.canCancel = false;
    }
    await this.queue.stop(); this.publish();
  }
}
