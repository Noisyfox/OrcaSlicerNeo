import type {
  PaintingApi, PaintingSessionMetadata, PaintingDraftResult, PaintingPointerEvent,
  PaintingSettings, PaintingTool, PaintingGeometryResult, HistoryStatus, SlicerClient,
  FilamentSessionSnapshot, FilamentMutationSummary,
} from '@slicer/client';

export type PaintTool = Exclude<PaintingTool, 'eraseAll'>;
export type PaintingPhase = 'closed' | 'opening' | 'idle' | 'drawing' | 'ending' | 'cancelling' | 'closing' | 'error';
/** One complete visual receipt. Interaction metadata may advance while this
 * session, resource manifest and palette remain together on screen. */
export interface PaintingDisplay extends Extract<PaintingGeometryResult, { ok: true }> {
  session: PaintingSessionMetadata;
  palette: FilamentSessionSnapshot | null;
}
/** Stroke/preview revisions can advance without changing the displayed target.
 * A metadata handoff that changes its parts or transforms must finish first. */
function paintingDisplayMatchesTarget(display: PaintingDisplay | null, session: PaintingSessionMetadata | null): boolean {
  if (!display || !session) return false;
  const shown = display.session;
  const equal = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i]);
  return shown.id === session.id && shown.objectId === session.objectId && shown.instanceId === session.instanceId
    && equal(shown.instanceTransform, session.instanceTransform) && shown.parts.length === session.parts.length
    && shown.parts.every((part) => session.parts.some((p) => p.volumeId === part.volumeId && p.sourceTriangleCount === part.sourceTriangleCount && equal(p.volumeTransform, part.volumeTransform)));
}
export interface PaintingState {
  phase: PaintingPhase;
  session: PaintingSessionMetadata | null;
  tool: PaintTool;
  settings: Required<PaintingSettings>;
  error: string | null;
  display: PaintingDisplay | null;
  /** Native metadata generation for rejecting obsolete geometry receipts. */
  epoch: number;
}
export interface PaintingPorts {
  coordinate<T>(operation: () => Promise<T>): Promise<T>;
  palette(): FilamentSessionSnapshot | null;
  targetAvailable(objectId: number, instanceId: number): boolean;
  api: PaintingApi & Pick<SlicerClient, 'openHistorySession' | 'closeHistorySession'>;
  history(status: HistoryStatus): void;
  committed(plates: readonly string[]): void;
  prepareClosed(): Promise<void>;
  schedule(callback: () => void): () => void;
}
type Sample = { event: PaintingPointerEvent; settings: PaintingSettings };
type Terminal = { kind: 'commit'; sample?: Sample } | { kind: 'cancel' };
const defaults: Required<PaintingSettings> = { state: 1, erase: false, radius: 2, height: 1, angle: 30, gapArea: 0 };

/** One RPC lane, shared by input and display. Moves are never retained. Only
 * a press (behind a display read) and a reliable terminal may wait for the lane.
 * The scheduler coalesces display opportunities, not admitted painting input. */
export class PaintingController {
  private state: PaintingState = { phase: 'closed', session: null, tool: 'circle', settings: defaults, error: null, display: null, epoch: 0 };
  private listeners = new Set<() => void>();
  private lane: Promise<unknown> | null = null;
  private terminal: Terminal | null = null;
  private terminalExecuting = false;
  private historyId: string | null = null;
  private displayDirty = false;
  private cancelFrame: (() => void) | null = null;
  private known = new Set<string>();
  private hover: PaintingPointerEvent | undefined;
  private previewDirty = false;
  private settingsVersion = 0;
  private selectedFilamentId: string | null = null;
  private projectOperations = 0;
  constructor(private ports: PaintingPorts) {}
  getSnapshot = (): PaintingState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  get unfinished(): boolean { return ['drawing', 'ending', 'cancelling'].includes(this.state.phase); }
  get active(): boolean { return this.state.phase !== 'closed'; }
  get commandAllowed(): boolean { return !this.active || this.state.phase === 'idle' || this.projectOperations > 0; }
  selectionAllowed(restoring = false): boolean {
    return !this.active || this.state.phase === 'idle' || (restoring && this.state.phase === 'opening');
  }
  private update(value: Partial<PaintingState>): void { this.state = { ...this.state, ...value }; this.listeners.forEach((l) => l()); }
  private identity() {
    const s = this.state.session;
    if (!s) throw new Error('Painting session is not open');
    return { version: 1 as const, sessionId: s.id, revision: s.revision };
  }
  private stroke() {
    const strokeId = this.state.session?.strokeId;
    if (!strokeId) throw new Error('Painting stroke is not open');
    return { ...this.identity(), strokeId };
  }
  private receipt(result: PaintingDraftResult): Exclude<PaintingDraftResult, { error: string }> {
    if ('error' in result) throw new Error(result.error);
    const session = this.state.session;
    if (!session || result.sessionId !== session.id || result.revision < session.revision) throw new Error('Stale painting response');
    this.update({ session: { ...session, revision: result.revision, strokeId: result.strokeId, phase: result.phase } });
    this.displayDirty = true;
    return result;
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    // Callers reserve phase synchronously before waiting. Ordinary moves never
    // call this while occupied; terminal/press/close wait without dropping input.
    const previous = this.lane;
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    this.lane = mine;
    try { if (previous) await previous; return await this.ports.coordinate(operation); }
    finally { if (this.lane === mine) this.lane = null; release(); this.scheduleDisplay(); }
  }
  private fail(error: unknown): void { this.update({ error: error instanceof Error ? error.message : String(error) }); }
  async open(objectId: number, instanceId: number): Promise<boolean> {
    if (this.active) return false;
    this.update({ phase: 'opening', error: null });
    return this.exclusive(async () => {
      try {
        const history = await this.ports.api.openHistorySession();
        this.historyId = history.sessionId; this.ports.history(history.status);
        const result = await this.ports.api.openPaintingSession({ version: 1, historySessionId: history.sessionId, objectId, instanceId });
        if ('error' in result) throw new Error(result.error);
        this.update({ session: result.session, phase: 'idle', epoch: this.state.epoch + 1 });
        this.displayDirty = true; this.previewDirty = this.state.tool === 'gap';
        return true;
      } catch (error) {
        this.fail(error);
        if (this.historyId) {
          try { this.ports.history(await this.ports.api.closeHistorySession(this.historyId)); this.historyId = null; }
          catch (closeError) { this.fail(closeError); this.update({ phase: 'error' }); return false; }
        }
        this.update({ phase: 'closed' }); return false;
      }
    });
  }
  async target(objectId: number, instanceId: number): Promise<boolean> {
    if (this.state.phase !== 'idle') return false;
    if (this.state.session?.objectId === objectId && this.state.session.instanceId === instanceId) return true;
    this.update({ phase: 'opening' });
    return this.exclusive(async () => {
      try {
        const result = await this.ports.api.targetPaintingSession({ ...this.identity(), objectId, instanceId });
        if ('error' in result) throw new Error(result.error);
        this.known.clear(); this.hover = undefined;
        this.update({ session: result.session, epoch: this.state.epoch + 1, phase: 'idle' });
        this.displayDirty = true; this.previewDirty = this.state.tool === 'gap'; return true;
      } catch (error) { this.fail(error); this.update({ phase: 'idle' }); return false; }
    });
  }
  setTool(tool: PaintTool): void {
    if (this.unfinished || !['idle', 'closed'].includes(this.state.phase)) return;
    this.update({ tool, display: this.withoutCandidates() });
    this.previewDirty = tool === 'gap' || tool === 'region' || tool === 'triangle'; this.settingsVersion++; this.scheduleDisplay();
  }
  setSettings(value: Partial<Required<PaintingSettings>>): void {
    const next = { ...this.state.settings, ...value };
    if (!Number.isInteger(next.state) || next.state < 1 || next.state > 16 ||
      !Number.isFinite(next.radius) || next.radius <= 0 || !Number.isFinite(next.height) || next.height <= 0 ||
      !Number.isFinite(next.gapArea) || next.gapArea < 0 || next.gapArea > 5 ||
      (next.angle !== null && (!Number.isFinite(next.angle) || next.angle < 0 || next.angle > 90))) return;
    this.settingsVersion++; this.update({ settings: next, display: this.withoutCandidates() });
    if (value.state !== undefined) this.selectedFilamentId = this.ports.palette()?.slots.find((slot) => slot.slot === next.state)?.logicalId ?? null;
    this.previewDirty = true; this.scheduleDisplay();
  }
  remapPalette(mapping: Readonly<Record<number, number>>, count: number): void {
    const state = mapping[this.state.settings.state] ?? this.state.settings.state;
    this.setSettings({ state: state >= 1 && state <= Math.min(16, count) ? state : 1 });
  }
  resetProjectPalette(): void { this.setSettings({ state: 1 }); }
  reconcilePalette(snapshot: FilamentSessionSnapshot, mutation?: FilamentMutationSummary): void {
    if (mutation?.kind === 'merge' && mutation.source === this.state.settings.state && mutation.destination) {
      this.selectedFilamentId = snapshot.slots.find((slot) => slot.slot === mutation.destination)?.logicalId ?? null;
    }
    const selected = this.selectedFilamentId
      ? snapshot.slots.find((slot) => slot.logicalId === this.selectedFilamentId)
      : snapshot.slots.find((slot) => slot.slot === this.state.settings.state);
    const slot = selected && selected.slot <= 16 ? selected : snapshot.slots[0];
    this.setSettings({ state: slot?.slot ?? 1 });
    this.selectedFilamentId = slot?.logicalId ?? null;
  }
  private settings(erase: boolean): PaintingSettings { return { ...this.state.settings, erase: erase || this.state.settings.erase }; }
  private withoutCandidates() { return this.state.display ? { ...this.state.display, candidates: [] } : null; }
  hoverAt(event?: PaintingPointerEvent): void {
    // Triangle hover admits one event, without replacing it with a later busy
    // move. Leave is a reliable visual invalidation even during a native read.
    if (event && (this.state.phase !== 'idle' || (this.state.tool === 'triangle' && (this.lane || (this.previewDirty && this.hover))))) return;
    if (!event && !['idle', 'drawing', 'ending'].includes(this.state.phase)) return;
    this.hover = event;
    this.update({ display: this.withoutCandidates() });
    if (this.state.tool === 'region' || this.state.tool === 'triangle') { this.previewDirty = true; this.settingsVersion++; this.scheduleDisplay(); }
  }
  /** Native hit is the sole authority for the initial paint/camera decision. */
  async press(event: PaintingPointerEvent, erase = false): Promise<'paint' | 'camera' | 'ignored'> {
    if (this.state.phase !== 'idle' || this.state.tool === 'gap') return 'ignored';
    if (!this.lane && !paintingDisplayMatchesTarget(this.state.display, this.state.session)) return 'ignored';
    const sample = { event, settings: this.settings(erase) }, tool = this.state.tool;
    if (tool === 'triangle') { this.hover = event; this.settingsVersion++; }
    this.terminal = null; this.update({ phase: 'drawing', error: null, display: this.withoutCandidates() });
    return this.exclusive(async () => {
      try {
        if (!paintingDisplayMatchesTarget(this.state.display, this.state.session)) {
          this.terminal = null; this.update({ phase: 'idle' }); return 'ignored';
        }
        const result = this.receipt(await this.ports.api.beginPaintingStroke({ ...this.identity(), tool, ...sample }));
        if (!result.hit && !this.terminal) {
          this.receipt(await this.ports.api.cancelPaintingStroke(this.stroke()));
          this.update({ phase: 'idle' }); return 'camera';
        }
        await this.drainTerminal(); return 'paint';
      } catch (error) { await this.recover(error); return 'ignored'; }
    });
  }
  move(event: PaintingPointerEvent, erase = false): boolean {
    if (this.state.phase !== 'drawing' || this.lane || this.terminal) return false;
    const sample = { event, settings: this.settings(erase) };
    if (this.state.tool === 'triangle') { this.hover = event; this.settingsVersion++; this.update({ display: this.withoutCandidates() }); }
    void this.exclusive(async () => {
      try { this.receipt(await this.ports.api.samplePaintingStroke({ ...this.stroke(), ...sample })); await this.drainTerminal(); }
      catch (error) { await this.recover(error); }
    });
    return true;
  }
  release(event?: PaintingPointerEvent, erase = false): void {
    if (!this.unfinished || this.terminal) return;
    if (this.state.tool === 'triangle' && event) { this.hover = event; this.settingsVersion++; }
    this.terminal = { kind: 'commit', ...(event ? { sample: { event, settings: this.settings(erase) } } : {}) };
    this.update({ phase: 'ending' }); this.startTerminal();
  }
  cancel(): void {
    if (!this.unfinished || this.terminalExecuting) return;
    this.terminal = { kind: 'cancel' }; this.update({ phase: 'cancelling' }); this.startTerminal();
  }
  private startTerminal(): void {
    if (this.lane) return;
    void this.exclusive(async () => { try { await this.drainTerminal(); } catch (error) { await this.recover(error); } });
  }
  private async drainTerminal(): Promise<void> {
    const terminal = this.terminal;
    if (!terminal || !this.state.session?.strokeId) return;
    this.terminalExecuting = true;
    // A terminal already executing cannot be superseded by capture loss or Escape.
    if (terminal.kind === 'cancel') this.receipt(await this.ports.api.cancelPaintingStroke(this.stroke()));
    else {
      const result = await this.ports.api.commitPaintingStroke({ ...this.stroke(), ...terminal.sample });
      if ('error' in result) {
        if (result.recovered && this.state.session?.id === result.sessionId) {
          this.update({ session: { ...this.state.session, phase: 'idle', strokeId: null, revision: result.revision } });
        }
        throw new Error(result.error);
      }
      this.receipt(result); this.ports.history(result.history);
      if (result.committed) this.ports.committed(result.affectedPlateIds);
    }
    this.terminal = null; this.terminalExecuting = false; this.update({ phase: 'idle' });
    this.previewDirty = this.state.tool === 'gap' || (this.state.tool === 'triangle' && !!this.hover);
  }
  private async recover(error: unknown): Promise<void> {
    this.fail(error); this.terminal = null; this.terminalExecuting = false;
    try {
      const latest = await this.ports.api.readPaintingSession({ ...this.identity(), latest: true });
      if ('error' in latest) throw new Error(latest.error);
      this.update({ session: latest.session });
      if (latest.session.strokeId) this.receipt(await this.ports.api.cancelPaintingStroke(this.stroke()));
      this.update({ phase: this.projectOperations > 0 ? 'opening' : 'idle', epoch: this.state.epoch + 1 });
      this.displayDirty = true;
    } catch (recoveryError) { this.fail(recoveryError); this.update({ phase: 'error' }); }
  }
  async apply(tool: 'gap' | 'eraseAll'): Promise<boolean> {
    if (this.state.phase !== 'idle') return false;
    if (!this.lane && !paintingDisplayMatchesTarget(this.state.display, this.state.session)) return false;
    const settings = this.settings(false);
    this.update({ phase: 'drawing', error: null });
    return this.exclusive(async () => {
      try {
        if (!paintingDisplayMatchesTarget(this.state.display, this.state.session)) { this.update({ phase: 'idle' }); return false; }
        let candidateRevision: number | undefined;
        if (tool === 'gap') {
          const preview = this.receipt(await this.ports.api.previewPainting({ ...this.identity(), tool, settings }));
          candidateRevision = preview.candidateRevision ?? undefined;
        }
        this.receipt(await this.ports.api.beginPaintingStroke({ ...this.identity(), tool, settings, candidateRevision }));
        this.terminal ??= { kind: 'commit' }; this.update({ phase: this.terminal.kind === 'cancel' ? 'cancelling' : 'ending' });
        await this.drainTerminal(); return true;
      } catch (error) { await this.recover(error); return false; }
    });
  }
  /** History uses the same lane as display and input, and refreshes native
   * selector identity only after the authoritative restore is complete. */
  async betweenStrokes(operation: () => Promise<boolean>): Promise<boolean> {
    try { return await this.projectOperation(operation); } catch { return false; }
  }
  /** Ordinary project revisions share the input/display lane and reserve it
   * before entering the application's FIFO. Rejected commands are not queued. */
  async projectOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.active) return operation();
    if (!this.commandAllowed) throw new Error('Painting command is busy');
    this.projectOperations++;
    this.update({ phase: 'opening' });
    try { return await this.exclusive(async () => {
      try {
        if (!this.active) return operation();
        const result = await operation();
        const target = this.state.session;
        if (target && !this.ports.targetAvailable(target.objectId, target.instanceId)) {
          await this.closeOwned();
          return result;
        }
        const latest = await this.ports.api.readPaintingSession({ ...this.identity(), latest: true });
        if ('error' in latest) throw new Error(latest.error);
        this.update({ session: latest.session, epoch: this.state.epoch + 1 });
        this.displayDirty = true; this.previewDirty = this.state.tool === 'gap'; return result;
      } catch (error) { await this.recover(error); throw error; }
    }); } finally {
      this.projectOperations--;
      if (this.state.phase === 'opening' && this.projectOperations === 0) this.update({ phase: 'idle' });
      this.scheduleDisplay();
    }
  }
  async close(): Promise<boolean> {
    if (!['idle', 'error'].includes(this.state.phase)) return false;
    const previousPhase = this.state.phase;
    this.update({ phase: 'closing' });
    return this.exclusive(async () => {
      try {
        await this.closeOwned(); return true;
      } catch (error) { this.fail(error); this.update({ phase: this.historyId ? previousPhase : 'error' }); return false; }
    });
  }
  private async closeOwned(): Promise<void> {
    // Called only while owning the input/display/project lane.
    // A renderer publication failure reserves error phase while a native draft
    // can still be open. Cancel it before closing history; a failed cancellation
    // retains the draft identity so an explicit close can retry safely.
    if (this.state.session?.strokeId) {
      this.receipt(await this.ports.api.cancelPaintingStroke(this.stroke()));
      this.terminal = null; this.terminalExecuting = false;
    }
    if (this.historyId) { this.ports.history(await this.ports.api.closeHistorySession(this.historyId, 'Paint')); this.historyId = null; }
    await this.ports.prepareClosed();
    this.known.clear(); this.cancelFrame?.(); this.cancelFrame = null;
    this.displayDirty = false; this.previewDirty = false; this.hover = undefined;
    this.update({ phase: 'closed', session: null, display: null, error: null, epoch: this.state.epoch + 1 });
  }
  private scheduleDisplay(): void {
    if (this.lane || this.cancelFrame || !this.state.session || !['idle', 'drawing'].includes(this.state.phase) || (!this.displayDirty && !(this.previewDirty && this.state.phase === 'idle'))) return;
    this.cancelFrame = this.ports.schedule(() => {
      this.cancelFrame = null;
      if (this.lane || !['idle', 'drawing'].includes(this.state.phase)) return;
      void this.exclusive(async () => {
        try {
          const previewVersion = this.settingsVersion;
          if (this.state.phase === 'idle' && this.previewDirty) {
            this.previewDirty = false;
            const tool = this.state.tool;
            if (((tool === 'region' || tool === 'triangle') && this.hover) || tool === 'gap') {
              this.receipt(await this.ports.api.previewPainting({ ...this.identity(), tool, settings: this.settings(false), ...(tool !== 'gap' ? { event: this.hover } : {}) }));
            }
          }
          if (this.displayDirty) {
            this.displayDirty = false;
            const identity = this.identity(), epoch = this.state.epoch;
            const result = await this.ports.api.getPaintingGeometry({ ...identity, knownResourceIds: [...this.known] });
            if ('error' in result) throw new Error(result.error);
            if (epoch === this.state.epoch && result.sessionId === this.state.session?.id && result.revision === this.state.session.revision) {
              // Retain CPU resources referenced by a reused native manifest only.
              const resources = new Map(this.state.display?.resources.map((r) => [r.resourceId, r]));
              result.resources.forEach((r) => resources.set(r.resourceId, r));
              const candidates = previewVersion === this.settingsVersion && (this.state.tool === 'gap' || ((this.state.tool === 'region' || this.state.tool === 'triangle') && this.hover)) ? result.candidates.filter((c) => c.kind === this.state.tool) : [];
              const active = new Set([...result.parts, ...candidates].map((r) => r.resourceId));
              for (const id of active) if (!resources.has(id)) throw new Error(`Missing painting resource ${id}`);
              const session = this.state.session;
              if (result.parts.length !== session.parts.length || new Set(result.parts.map((p) => p.volumeId)).size !== result.parts.length || session.parts.some((part) => !result.parts.some((r) => r.volumeId === part.volumeId))) throw new Error('Incomplete painting parts');
              for (const part of result.parts) if (resources.get(part.resourceId)!.volumeId !== part.volumeId || resources.get(part.resourceId)!.kind !== 'draft') throw new Error('Invalid painting part resource');
              for (const candidate of candidates) if (resources.get(candidate.resourceId)!.volumeId !== candidate.volumeId || resources.get(candidate.resourceId)!.kind !== candidate.kind) throw new Error('Invalid painting candidate resource');
              this.known = active;
              this.update({ display: { ...result, session, palette: this.ports.palette(), candidates, resources: [...resources.values()].filter((r) => active.has(r.resourceId)) } });
            }
          }
          await this.drainTerminal();
        } catch (error) { this.fail(error); if (this.terminal) await this.drainTerminal().catch((e) => this.recover(e)); }
      });
    });
  }
  reportDisplayError(error: unknown): void { this.fail(error); this.update({ phase: 'error' }); }
}
