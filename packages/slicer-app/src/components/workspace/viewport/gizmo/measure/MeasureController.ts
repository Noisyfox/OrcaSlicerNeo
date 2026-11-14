import type {
  MeasureApi, MeasureDisplay, MeasurePlane, MeasurePointerEvent, MeasureResetRequest,
  MeasureSessionId, MeasureStatus, MeasureTarget,
} from '@slicer/client';

export interface MeasureState {
  readonly phase: 'closed' | 'opening' | 'idle' | 'rebasing';
  readonly targets: readonly MeasureTarget[];
  readonly status: MeasureStatus | null;
  readonly display: MeasureDisplay | null;
  readonly planes: ReadonlyMap<string, MeasurePlane>;
  readonly error: string | null;
}
export interface MeasurePorts {
  readonly api: MeasureApi;
  /** Shares the project command lane without creating history or a mutation lease. */
  coordinate<T>(operation: () => Promise<T>): Promise<T>;
  /** Serial slicing must be rejected before an operation is queued. */
  canMeasure(): boolean;
  /** Changes when a serial slice finishes; threaded execution uses a stable key. */
  admissionKey(): string;
  invalidate(): void;
}
interface DisplayOwner { readonly display: MeasureDisplay; visible: boolean; references: number; released: boolean }
interface HoverRequest { readonly event: MeasurePointerEvent; readonly generation: number; readonly serial: number; readonly admission: string }
export interface MeasureScaleToken { readonly generation: number; readonly sessionId: MeasureSessionId }

function copyEvent(event: MeasurePointerEvent): MeasurePointerEvent {
  return { pointer: [...event.pointer], viewport: [...event.viewport], projection: [...event.projection], view: [...event.view] };
}
function targetKey(target: MeasureTarget): string { return `${target.objectId}:${target.instanceId}:${target.volumeId}`; }
function copyTargets(targets: readonly MeasureTarget[]): MeasureTarget[] {
  return [...new Map(targets.map(target => [targetKey(target), { ...target }])).values()];
}

/** A single ordered lane owns native sessions, clicks and display resources.
 * Hover is coalesced; admitted clicks keep their own immutable input and the
 * displayed snapshot alive until that click has completed. */
export class MeasureController {
  private state: MeasureState = { phase: 'closed', targets: [], status: null, display: null, planes: new Map(), error: null };
  private listeners = new Set<() => void>();
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;
  private nativeId: MeasureSessionId | null = null;
  private visible: DisplayOwner | null = null;
  private hoverSerial = 0;
  private hoverScheduled = false;
  private pendingHover: HoverRequest | null = null;
  private lastEvent: MeasurePointerEvent | null = null;
  private planeLoads = new Set<string>();

  constructor(private readonly ports: MeasurePorts) {}
  getSnapshot = (): MeasureState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  get active(): boolean { return this.state.phase !== 'closed'; }

  private update(value: Partial<MeasureState>): void {
    this.state = { ...this.state, ...value };
    for (const listener of this.listeners) listener();
    this.ports.invalidate();
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => this.ports.coordinate(operation));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  /** Resolves after operations already admitted to this controller settle. */
  settled(): Promise<void> { return this.tail; }
  private fail(error: unknown): void {
    this.update({ error: error instanceof Error ? error.message : String(error) });
  }
  private closeAfterFailure(error: unknown): void {
    void this.close();
    this.fail(error);
  }
  private identity(status = this.state.status) {
    if (!status) throw new Error('Measure session is not open');
    return { version: 1 as const, sessionId: status.sessionId, targetRevision: status.targetRevision };
  }
  private admitted(key: string): boolean { return this.ports.canMeasure() && this.ports.admissionKey() === key; }
  private release(owner: DisplayOwner): void {
    if (owner.visible || owner.references || owner.released) return;
    owner.released = true;
    void this.enqueue(() => this.ports.api.releaseMeasureDisplay({ version: 1,
      sessionId: owner.display.sessionId, displayId: owner.display.displayId })).catch(error => {
      if (this.state.status?.sessionId === owner.display.sessionId) this.fail(error);
    });
  }
  private retireDisplay(): void {
    const owner = this.visible;
    this.visible = null;
    if (owner) { owner.visible = false; this.release(owner); }
  }
  private finishReference(owner: DisplayOwner | null): void {
    if (!owner) return;
    owner.references--;
    this.release(owner);
  }
  private async closeNative(id: MeasureSessionId): Promise<void> {
    const result = await this.ports.api.closeMeasureSession({ version: 1, sessionId: id });
    // A successful history or project replacement already invalidates the ID.
    if ('error' in result && !result.error.includes('stale')) throw new Error(result.error);
    if (this.nativeId === id) this.nativeId = null;
  }
  private invalidateLocal(phase: MeasureState['phase']): number {
    const generation = ++this.generation;
    this.hoverSerial++;
    this.pendingHover = null;
    this.lastEvent = null;
    this.retireDisplay();
    this.planeLoads.clear();
    this.update({ phase, status: null, display: null, planes: new Map(), error: null });
    return generation;
  }

  open(targets: readonly MeasureTarget[]): Promise<boolean> {
    const next = copyTargets(targets);
    if (!next.length || !this.ports.canMeasure()) {
      this.update({ error: next.length ? 'slice_busy' : 'No measurable selection' });
      return Promise.resolve(false);
    }
    const admission = this.ports.admissionKey();
    const generation = this.invalidateLocal('opening');
    this.update({ targets: next });
    return this.enqueue(async () => {
      if (generation !== this.generation) return false;
      if (!this.admitted(admission)) throw new Error('slice_busy');
      if (this.nativeId) await this.closeNative(this.nativeId);
      if (generation !== this.generation) return false;
      if (!this.admitted(admission)) throw new Error('slice_busy');
      const result = await this.ports.api.openMeasureSession({ version: 1, targets: next });
      if ('error' in result) throw new Error(result.error);
      this.nativeId = result.sessionId;
      if (generation !== this.generation) { await this.closeNative(result.sessionId); return false; }
      if (!this.admitted(admission)) { await this.closeNative(result.sessionId); throw new Error('slice_busy'); }
      this.update({ phase: 'idle', status: result, error: null });
      this.scheduleHover();
      return true;
    }).catch(error => {
      if (generation === this.generation) this.closeAfterFailure(error);
      return false;
    });
  }

  /** Closing changes the local UI immediately, even while native open is busy. */
  close(): Promise<void> {
    const generation = this.invalidateLocal('closed');
    this.update({ targets: [] });
    return this.enqueue(async () => { if (this.nativeId) await this.closeNative(this.nativeId); })
      .catch(error => { if (generation === this.generation) this.fail(error); });
  }

  hover(event: MeasurePointerEvent): void {
    if (!this.active || !this.ports.canMeasure()) return;
    const snapshot = copyEvent(event);
    this.lastEvent = snapshot;
    this.pendingHover = { event: snapshot, generation: this.generation, serial: ++this.hoverSerial, admission: this.ports.admissionKey() };
    this.scheduleHover();
  }
  /** Camera gestures obsolete both pending and displayed hover snapshots. */
  invalidateHover(): void {
    this.lastEvent = null;
    this.hoverSerial++;
    this.pendingHover = null;
    this.retireDisplay();
    if (this.state.display) this.update({ display: null });
  }
  private scheduleHover(): void {
    if (this.hoverScheduled || !this.pendingHover || this.state.phase !== 'idle' || !this.state.status || !this.ports.canMeasure()) return;
    this.hoverScheduled = true;
    const scheduledGeneration = this.generation;
    void this.enqueue(async () => {
      const request = this.pendingHover;
      this.pendingHover = null;
      const status = this.state.status;
      if (!request || !status || request.generation !== this.generation || this.state.phase !== 'idle' || !this.admitted(request.admission)) return;
      const result = await this.ports.api.getMeasureDisplay({ ...this.identity(status), event: request.event });
      if ('error' in result) { if (request.generation === this.generation) this.fail(result.error); return; }
      const current = this.state.status;
      if (request.generation !== this.generation || request.serial !== this.hoverSerial || this.state.phase !== 'idle' ||
          !this.admitted(request.admission) ||
          !current || result.sessionId !== current.sessionId || result.targetRevision !== current.targetRevision ||
          result.selectionRevision !== current.selectionRevision) {
        await this.ports.api.releaseMeasureDisplay({ version: 1, sessionId: result.sessionId, displayId: result.displayId });
        return;
      }
      this.retireDisplay();
      const owner: DisplayOwner = { display: result, visible: true, references: 0, released: false };
      this.visible = owner;
      this.update({ display: result, error: null });
      this.requestPlanes(owner, request.generation);
    }).catch(error => { if (scheduledGeneration === this.generation && this.active) this.closeAfterFailure(error); }).finally(() => {
      this.hoverScheduled = false;
      this.scheduleHover();
    });
  }

  /** Queue a captured press immediately; the caller owns the gesture synchronously. */
  click(event: MeasurePointerEvent, shift = false, marker?: number): boolean {
    if (this.state.phase !== 'idle' || !this.state.status || !this.ports.canMeasure()) return false;
    const generation = this.generation, admission = this.ports.admissionKey(), snapshot = copyEvent(event), owner = this.visible;
    if (marker !== undefined && (!owner || !owner.display.markers.some(value => value.index === marker))) return false;
    // A press is also the newest pointer snapshot. Any older hover response is
    // obsolete; the ordered click still retains the previously visible display.
    this.lastEvent = snapshot; this.hoverSerial++; this.pendingHover = null;
    if (owner) owner.references++;
    void this.enqueue(async () => {
      const status = this.state.status;
      if (generation !== this.generation || this.state.phase !== 'idle' || !status) return;
      if (!this.admitted(admission)) { this.fail('slice_busy'); return; }
      const result = await this.ports.api.clickMeasure({ ...this.identity(status), event: snapshot, shift,
        ...(owner ? { displayId: owner.display.displayId } : {}), ...(marker === undefined ? {} : { marker }) });
      if ('error' in result) { if (generation === this.generation) this.fail(result.error); return; }
      if (generation !== this.generation || this.state.phase !== 'idle') return;
      if (!this.admitted(admission)) { this.closeAfterFailure('slice_busy'); return; }
      this.update({ status: result, error: null });
      this.refreshHover();
    }).catch(error => { if (generation === this.generation) this.closeAfterFailure(error); })
      .finally(() => this.finishReference(owner));
    return true;
  }

  reset(action: MeasureResetRequest['action']): boolean {
    if (this.state.phase !== 'idle' || !this.state.status || !this.ports.canMeasure()) return false;
    const generation = this.generation, admission = this.ports.admissionKey();
    void this.enqueue(async () => {
      const status = this.state.status;
      if (generation !== this.generation || this.state.phase !== 'idle' || !status) return;
      if (!this.admitted(admission)) { this.fail('slice_busy'); return; }
      const result = await this.ports.api.resetMeasure({ ...this.identity(status), action });
      if ('error' in result) { if (generation === this.generation) this.fail(result.error); return; }
      if (generation !== this.generation || this.state.phase !== 'idle') return;
      if (!this.admitted(admission)) { this.closeAfterFailure('slice_busy'); return; }
      if (result.outcome === 'close') {
        this.invalidateLocal('closed'); this.update({ targets: [] });
        try { await this.closeNative(result.sessionId); } catch (error) { this.fail(error); }
        return;
      }
      this.update({ status: result, error: null });
      if (result.outcome === 'selected') this.refreshHover();
    }).catch(error => { if (generation === this.generation) this.closeAfterFailure(error); });
    return true;
  }

  private refreshHover(): void {
    if (this.lastEvent) this.hover(this.lastEvent);
    else { this.hoverSerial++; this.pendingHover = null; this.retireDisplay(); this.update({ display: null }); }
  }

  /** Freeze interaction only after previously admitted clicks have settled. */
  beginScale(expected: Pick<MeasureStatus, 'sessionId' | 'targetRevision' | 'selectionRevision'>): MeasureScaleToken | null {
    const current = this.state.status;
    if (this.state.phase !== 'idle' || !current || !this.ports.canMeasure() || current.sessionId !== expected.sessionId ||
        current.targetRevision !== expected.targetRevision || current.selectionRevision !== expected.selectionRevision) return null;
    const generation = ++this.generation;
    this.hoverSerial++; this.pendingHover = null; this.retireDisplay(); this.planeLoads.clear();
    this.update({ phase: 'rebasing', display: null, planes: new Map(), error: null });
    return { generation, sessionId: current.sessionId };
  }

  /** A retarget/close invalidates the token and cannot rebase a successor. */
  async finishScale(token: MeasureScaleToken, committed: boolean): Promise<boolean> {
    if (token.generation !== this.generation || this.state.phase !== 'rebasing' || this.state.status?.sessionId !== token.sessionId) return false;
    this.update({ phase: 'idle' });
    if (committed) return this.rebase();
    this.refreshHover();
    return true;
  }

  /** Called after the shared transform transaction has settled successfully. */
  rebase(): Promise<boolean> {
    const previous = this.state.status;
    if (this.state.phase !== 'idle' || !previous || !this.ports.canMeasure()) return Promise.resolve(false);
    const admission = this.ports.admissionKey();
    const generation = ++this.generation;
    this.hoverSerial++; this.pendingHover = null; this.retireDisplay(); this.planeLoads.clear();
    this.update({ phase: 'rebasing', display: null, planes: new Map(), error: null });
    return this.enqueue(async () => {
      if (generation !== this.generation) return false;
      if (!this.admitted(admission)) throw new Error('slice_busy');
      const result = await this.ports.api.rebaseMeasure(this.identity(previous));
      if ('error' in result) throw new Error(result.error);
      if (generation !== this.generation) return false;
      if (!this.admitted(admission)) throw new Error('slice_busy');
      this.update({ phase: 'idle', status: result, error: null });
      this.refreshHover();
      return true;
    }).catch(error => {
      if (generation === this.generation) this.closeAfterFailure(error);
      return false;
    });
  }

  private requestPlanes(owner: DisplayOwner, generation: number): void {
    const display = owner.display;
    const features = [
      { role: 'hover' as const, feature: display.hover?.feature },
      { role: 'first' as const, feature: display.first?.value },
      { role: 'second' as const, feature: display.second?.value },
    ];
    for (const { role, feature } of features) {
      if (feature?.type !== 'plane' || this.state.planes.has(feature.resourceId) || this.planeLoads.has(feature.resourceId)) continue;
      const resourceId = feature.resourceId;
      const admission = this.ports.admissionKey();
      this.planeLoads.add(resourceId); owner.references++;
      void this.enqueue(async () => {
        if (generation !== this.generation || !this.state.status || !this.admitted(admission)) return;
        const result = await this.ports.api.getMeasurePlane({ ...this.identity(), displayId: display.displayId, role, resourceId });
        if ('error' in result) throw new Error(result.error);
        if (generation !== this.generation || !this.state.status || !this.admitted(admission) || result.targetRevision !== this.state.status.targetRevision) return;
        const planes = new Map(this.state.planes); planes.set(resourceId, result);
        this.update({ planes });
      }).catch(error => { if (generation === this.generation) this.fail(error); }).finally(() => {
        this.planeLoads.delete(resourceId); this.finishReference(owner);
      });
    }
  }
}
