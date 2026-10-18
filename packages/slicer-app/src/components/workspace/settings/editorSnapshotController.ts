export class CommittedEditorRefreshError extends Error {
  constructor(cause: unknown) {
    super(`The edit was committed, but its editor could not be refreshed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'CommittedEditorRefreshError';
  }
}

interface EditorState<Context, Snapshot> {
  readonly loaded: { readonly context: Context; readonly snapshot: Snapshot } | null;
  readonly error: string | null;
  readonly refreshing: boolean;
  readonly pending: boolean;
}

/** One mounted editor session. Reads are coalesced before entering the native
 * client, and owned mutation receipts publish while their FIFO lease is held.
 */
export class EditorSnapshotController<Context, Snapshot extends { ok: true; revision: number }> {
  private active = false;
  private task: Promise<void> | null = null;
  private failedContext: Context | null = null;
  private listeners = new Set<() => void>();
  private state: EditorState<Context, Snapshot> = { loaded: null, error: null, refreshing: false, pending: false };

  constructor(private readonly options: {
    context(): Context;
    same(left: Context, right: Context): boolean;
    sameOwner(left: Context, right: Context): boolean;
    readable(context: Context): boolean;
    revision(context: Context): number | null;
    schedule(operation: () => Promise<void>): Promise<void>;
    read(context: Context): Promise<Snapshot | { ok: false; error: string }>;
  }) {}

  get = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  start() { this.active = true; void this.refresh(); }
  stop() { this.active = false; }

  private publish(update: Partial<EditorState<Context, Snapshot>>) {
    if (Object.entries(update).every(([key, value]) => this.state[key as keyof typeof this.state] === value)) return;
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }

  private current(context: Context) {
    const current = this.options.context();
    return this.active && this.options.readable(current) && this.options.same(context, current);
  }

  private satisfied(context: Context) {
    return this.state.loaded !== null && this.options.same(this.state.loaded.context, context);
  }

  private accept(context: Context, snapshot: Snapshot) {
    if (!this.current(context)) return;
    // External reads are guarded by their captured context and FIFO lease.
    // Geometry-only commands can advance native history without publishing a
    // new scoped-config mirror, so these two revision numbers need not match.
    this.failedContext = null;
    this.publish({ loaded: { context, snapshot }, error: null });
  }

  refresh(): Promise<void> {
    const context = this.options.context();
    if (!this.active || this.state.pending || !this.options.readable(context) || this.satisfied(context) ||
        (this.failedContext !== null && this.options.same(this.failedContext, context))) return this.task ?? Promise.resolve();
    if (this.task) return this.task;
    this.publish({ refreshing: true, error: null });
    let reading: Context | undefined;
    this.task = this.options.schedule(async () => {
      // Intermediate invalidations only schedule a reservation. Read the final
      // context at execution, after earlier mutations, rather than queueing RPCs.
      if (!this.active || this.state.pending) return;
      reading = this.options.context();
      if (!this.options.readable(reading) || this.satisfied(reading)) return;
      const result = await this.options.read(reading);
      if (!this.current(reading)) return;
      if (!result.ok) throw new Error(result.error);
      this.accept(reading, result);
    }).catch(error => {
      const failed = reading ?? context;
      if (this.current(failed)) {
        this.failedContext = failed;
        this.publish({ error: String(error) });
      }
    }).finally(() => {
      this.task = null;
      this.publish({ refreshing: false });
      if (!this.options.same(reading ?? context, this.options.context())) void this.refresh();
    });
    return this.task;
  }

  async mutate(operation: (publish: (snapshot: Snapshot) => void) => Promise<Snapshot>) {
    const captured = this.options.context();
    if (!this.current(captured) || !this.satisfied(captured) || this.state.pending || this.state.refreshing || this.state.error)
      throw new Error('Configuration is not ready for another edit.');
    this.publish({ pending: true });
    try {
      return await operation(snapshot => {
        const committed = this.options.context();
        if (this.options.sameOwner(captured, committed) && snapshot.revision === this.options.revision(committed))
          this.accept(committed, snapshot);
      });
    } catch (error) {
      const current = this.options.context();
      if (error instanceof CommittedEditorRefreshError && this.active && this.options.sameOwner(captured, current)) {
        this.failedContext = current;
        this.publish({ error: error.message });
      }
      throw error;
    } finally {
      this.publish({ pending: false });
      void this.refresh();
    }
  }
}
