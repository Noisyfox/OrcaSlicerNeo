/** Shared, consumer-owned U1 acquisition. Recovery reads state; it never replays commands. */
export class U1ObservationHub<T> {
  private users = 0;
  private inFlight?: Promise<T>;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private failures = 0;
  private revision = 0;
  private listeners = new Set<() => void>();
  private error: unknown;
  constructor(private readonly acquire: (signal: AbortSignal) => Promise<T>, private readonly stale: () => void, private readonly periodMs = 2000) {}
  get unavailable() { return this.error !== undefined; }
  get active() { return this.users > 0; }
  private notify() { this.revision++; for (const listener of this.listeners) listener(); }
  refresh(): Promise<T> {
    if (this.inFlight) return this.inFlight;
    clearTimeout(this.timer); this.timer = undefined;
    const controller = new AbortController(); this.controller = controller;
    this.inFlight = this.acquire(controller.signal).then(value => {
      this.failures = 0; this.error = undefined;
      if (!this.active) this.stale();
      this.notify(); return value;
    }, error => {
      this.stale(); this.failures++; this.error = error; this.notify(); throw error;
    }).finally(() => {
      this.inFlight = undefined; this.controller = undefined;
      if (this.active && this.failures < 3) this.timer = setTimeout(() => { void this.refresh().catch(() => undefined); }, this.periodMs * 2 ** this.failures);
    });
    return this.inFlight;
  }
  retain(): () => void {
    this.users++;
    if (this.users === 1) { this.failures = 0; void this.refresh().catch(() => undefined); }
    let released = false;
    return () => {
      if (released) return; released = true; this.users--;
      if (!this.active) { clearTimeout(this.timer); this.timer = undefined; this.controller?.abort(); this.stale(); }
    };
  }
  async *watch(signal?: AbortSignal): AsyncIterable<void> {
    if (signal?.aborted) return;
    let wake: (() => void) | undefined;
    const notify = () => wake?.(); this.listeners.add(notify); signal?.addEventListener('abort', notify);
    const release = this.retain(); let revision = -1;
    try {
      while (!signal?.aborted) {
        if (revision !== this.revision) {
          revision = this.revision;
          yield;
          if (this.failures >= 3) throw this.error;
        }
        if (revision === this.revision && !signal?.aborted) await new Promise<void>(resolve => { wake = resolve; });
        wake = undefined;
      }
    } finally { this.listeners.delete(notify); signal?.removeEventListener('abort', notify); release(); }
  }
}
