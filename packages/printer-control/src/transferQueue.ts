/** Host-neutral admission shared by download and stored-media readers. */
import type { TransferCompletion, TransferSnapshot, TransferTicket, TransferRequest } from '@orca/platform-contract';

interface Entry {
  request: TransferRequest;
  snapshot: TransferSnapshot;
  controller?: AbortController;
  finish(): void;
}

/**
 * A single host-wide instance arbitrates readers across provider execution hosts.
 * The host must join execution/cleanup before run() settles. A blocked head does
 * not hold a global slot, but it prevents later requests for that printer starting.
 */
export class TransferQueue {
  private entries: Entry[] = [];
  private active = 0;
  private scheduled = false;
  private closed = false;
  private stopping?: Promise<void>;
  private completions = new Set<Promise<void>>();

  constructor(private readonly maxActive: number) {
    if (!Number.isSafeInteger(maxActive) || maxActive <= 0) throw new Error('Invalid transfer concurrency budget.');
  }

  enqueue(request: TransferRequest): TransferTicket {
    if (this.closed) throw new Error('Transfer admission is closed.');
    if (!request.physicalPrinterKey) throw new Error('A physical printer identity is required.');
    let resolve!: () => void;
    const finished = new Promise<void>(done => { resolve = done; });
    const entry: Entry = { request: { ...request }, snapshot: { state: 'waiting', attempt: 0, reason: null }, finish: resolve };
    this.entries.push(entry);
    this.completions.add(finished);
    void finished.then(() => this.completions.delete(finished));
    this.emit(entry);
    this.schedule();
    return {
      snapshot: () => this.copy(entry.snapshot), finished,
      cancel: () => this.cancel(entry),
      retry: () => {
        if (this.closed || entry.snapshot.state !== 'blocked') return false;
        entry.snapshot = { ...entry.snapshot, state: 'waiting', reason: null };
        this.emit(entry); this.schedule(); return true;
      },
      continue: () => {
        if (entry.snapshot.state !== 'blocked') return false;
        this.finish(entry); return true;
      },
    };
  }

  /** Close admission first, then cancel all waiting/blocked/running work and join it. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    const unfinished = [...this.completions];
    for (const entry of [...this.entries]) this.cancel(entry);
    this.stopping = Promise.all(unfinished).then(() => undefined);
    return this.stopping;
  }

  private copy(snapshot: TransferSnapshot): TransferSnapshot {
    return { ...snapshot, reason: snapshot.reason ? { ...snapshot.reason } : null };
  }
  private emit(entry: Entry): void {
    try { entry.request.changed?.(this.copy(entry.snapshot)); } catch { /* View failures cannot own scheduling. */ }
  }
  private cancel(entry: Entry): void {
    if (entry.snapshot.state === 'finished' || entry.snapshot.state === 'stopping') return;
    if (entry.snapshot.state === 'running') {
      entry.snapshot = { ...entry.snapshot, state: 'stopping' };
      entry.controller?.abort(); this.emit(entry);
    } else this.finish(entry);
  }
  private finish(entry: Entry): void {
    const index = this.entries.indexOf(entry);
    if (index < 0) return;
    this.entries.splice(index, 1);
    entry.snapshot = { ...entry.snapshot, state: 'finished' };
    entry.controller = undefined;
    entry.finish(); this.emit(entry); this.schedule();
  }
  private schedule(): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }
  private pump(): void {
    if (this.closed) return;
    const seen = new Set<string>();
    // Array order preserves admission order across printers competing for global capacity.
    for (const entry of [...this.entries]) {
      if (this.closed || this.active >= this.maxActive) break;
      const key = entry.request.physicalPrinterKey;
      if (seen.has(key)) continue;
      seen.add(key);
      if (entry.snapshot.state !== 'waiting') continue;
      this.active++;
      entry.controller = new AbortController();
      entry.snapshot = { state: 'running', attempt: entry.snapshot.attempt + 1, reason: null };
      const controller = entry.controller, attempt = entry.snapshot.attempt;
      this.emit(entry);
      void this.execute(entry, controller, attempt);
    }
  }
  private async execute(entry: Entry, controller: AbortController, attempt: number): Promise<void> {
    let result: TransferCompletion;
    try {
      result = controller.signal.aborted ? { status: 'finished' }
        : await entry.request.run({ signal: controller.signal, attempt });
    } catch {
      // Unclassified host failures require acknowledgement, not an automatic restart loop.
      result = { status: 'blocked', reason: { code: 'device-failed', message: 'The transfer executor failed.' } };
    }
    this.active--;
    entry.controller = undefined;
    if (result.status === 'blocked' && !controller.signal.aborted && !this.closed) {
      entry.snapshot = { state: 'blocked', attempt, reason: { ...result.reason } };
      this.emit(entry); this.schedule();
    } else this.finish(entry);
  }
}
