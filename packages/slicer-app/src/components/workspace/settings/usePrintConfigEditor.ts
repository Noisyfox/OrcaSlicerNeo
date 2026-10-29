import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ConfigEditorSnapshot, NativeScopedConfigMutationRequest, ScopedConfigEditorSnapshot, ScopedConfigEditorTarget } from '@slicer/client';
import type { PlatformCapabilities } from '@orca/platform-contract';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useHistoryRestoreStore } from '@/stores/useHistoryRestoreStore';
import { CommittedEditorRefreshError, commitPrintConfigurationMutation, readConfigurationEditor, commitScopedEditorMutation } from './configurationActions';

function editorContext(runtime: PlatformCapabilities['runtime'], targets: readonly ScopedConfigEditorTarget[] | null, enabled: boolean) {
  const settings = useSettingsStore.getState();
  const history = useHistoryRestoreStore.getState();
  return { runtime, targets, enabled, identity: targets === null ? 'project' : JSON.stringify(targets),
    base: settings.baseValues, refreshRequired: settings.nativeScopedConfigRefreshRequired, revision: settings.nativeScopedConfigRevision, entry: settings.printEditorEntry,
    metadata: settings.metadata, printer: settings.selectedPrinter, print: settings.selectedPrint,
    historyRevision: history.revision, historyPhase: history.phase };
}
type EditorContext = ReturnType<typeof editorContext>;
const contextKeys = ['runtime', 'identity', 'base', 'revision', 'entry', 'metadata', 'printer', 'print', 'historyRevision', 'refreshRequired'] as const;
const sameContext = (left: EditorContext, right: EditorContext) => contextKeys.every(key => left[key] === right[key]);
const sameOwner = (left: EditorContext, right: EditorContext) =>
  left.runtime === right.runtime && left.identity === right.identity && left.entry === right.entry &&
  left.metadata === right.metadata && left.printer === right.printer && left.historyRevision === right.historyRevision;
const readable = (context: EditorContext) => context.enabled && !context.refreshRequired && context.metadata !== null && context.revision !== null &&
  context.historyPhase === 'idle' && (context.targets === null || context.targets.length > 0);

function useEditorSession<Snapshot extends { ok: true; revision: number }>(platform: PlatformCapabilities,
  targets: readonly ScopedConfigEditorTarget[] | null, enabled: boolean,
  read: (context: EditorContext) => Promise<Snapshot | { ok: false; error: string }>) {
  const base = useSettingsStore(state => state.baseValues);
  const revision = useSettingsStore(state => state.nativeScopedConfigRevision);
  const entry = useSettingsStore(state => state.printEditorEntry);
  const refreshRequired = useSettingsStore(state => state.nativeScopedConfigRefreshRequired);
  const metadata = useSettingsStore(state => state.metadata);
  const printer = useSettingsStore(state => state.selectedPrinter);
  const print = useSettingsStore(state => state.selectedPrint);
  const historyRevision = useHistoryRestoreStore(state => state.revision);
  const historyPhase = useHistoryRestoreStore(state => state.phase);
  const identity = targets === null ? 'project' : JSON.stringify(targets);
  const committed = useRef({ targets, enabled });
  const controller = useMemo(() => new EditorSnapshotController<EditorContext, Snapshot>({
    context: () => editorContext(platform.runtime, committed.current.targets, committed.current.enabled),
    same: sameContext, sameOwner, readable, revision: context => context.revision,
    schedule: readConfigurationEditor, read,
  }), [platform.runtime]);
  const state = useSyncExternalStore(controller.subscribe, controller.get, controller.get);
  useLayoutEffect(() => {
    committed.current = { targets, enabled };
    void controller.refresh();
  }, [controller, identity, enabled, base, revision, entry, metadata, printer, print, historyRevision, historyPhase, refreshRequired]);
  useEffect(() => { controller.start(); return () => controller.stop(); }, [controller]);
  const context = editorContext(platform.runtime, targets, enabled);
  const current = readable(context) && state.loaded !== null && sameContext(state.loaded.context, context);
  return { controller, state, context, current };
}

export function useScopedConfigEditor(platform: PlatformCapabilities, targets: readonly ScopedConfigEditorTarget[], enabled: boolean) {
  const { controller, state, context, current } = useEditorSession<ScopedConfigEditorSnapshot>(platform, targets, enabled,
    context => context.runtime.getScopedConfigEditor({ version: 1, targets: context.targets! }));
  const mutate = useCallback((request: NativeScopedConfigMutationRequest, capturedTargets: readonly ScopedConfigEditorTarget[]) =>
    controller.mutate(publish => commitScopedEditorMutation(platform, request, capturedTargets, publish)), [controller, platform]);
  const loaded = state.loaded;
  // Display-only retention cannot authorize a mutation. The controller checks
  // the complete context and uses the final receipt's current revision.
  const displaySnapshot = loaded && loaded.context.identity === context.identity && loaded.context.entry === context.entry &&
    loaded.context.printer === context.printer && loaded.context.print === context.print && loaded.context.metadata === context.metadata
    ? loaded.snapshot : null;
  return { snapshot: current ? loaded!.snapshot : null, displaySnapshot,
    selection: loaded?.context.entry === context.entry ? loaded.snapshot.editorSelection : null,
    identity: context.identity, entry: context.entry, error: state.error, pending: state.pending,
    refreshing: state.refreshing || !current || context.historyPhase !== 'idle', mutate };
}

export function usePrintConfigEditor(platform: PlatformCapabilities, enabled: boolean) {
  const { controller, state, context, current } = useEditorSession<ConfigEditorSnapshot>(platform, null, enabled,
    context => context.runtime.getPrintConfigEditor());
  const mutate = useCallback((request: NativeScopedConfigMutationRequest) =>
    controller.mutate(publish => commitPrintConfigurationMutation(platform, request, publish)), [controller, platform]);
  return { snapshot: state.loaded?.snapshot ?? null, entry: context.entry, error: state.error, pending: state.pending,
    refreshing: state.refreshing || !current || context.historyPhase !== 'idle', mutate };
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
