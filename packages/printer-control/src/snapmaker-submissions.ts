/** Host-lifetime U1 delivery. Observing/closing a dialog never cancels this executor. */
import type * as D from './domain';
import type { PrinterConfiguration } from './configuration';
import { MoonrakerFailure, MoonrakerHttp, fail, publicError } from './moonraker-http';
import { copy, newId, requestSignature } from './operations';
import { prepareU1Print } from './snapmaker-protocol';
import { u1BindingHead } from './snapmaker-preparation';

export const U1_SEND_FAILURE = 'Send print task failed, please try again';
interface Entry {
  value: D.PrintSubmissionState;
  revision: number;
  listeners: Set<() => void>;
  abort: AbortController;
  /** Execution evidence is retained even when presentation uses the generic failure. */
  evidence: { remoteFileMayExist: boolean; preparationAcknowledged: number; startDispatched: boolean; startAcknowledged: boolean; outcomeUnknown: boolean };
}
interface Dependencies {
  http: MoonrakerHttp;
  resolve(target: D.TargetRequest): Promise<{ printer: PrinterConfiguration; revision: string }>;
  prepare: D.PrinterSubmissions['prepare'];
  retainObservation?(target: D.TargetRequest): Promise<() => void>;
}
const terminal = (phase: D.PrintSubmissionState['phase']) => ['sent', 'failed', 'cancelled', 'unknown'].includes(phase);
export class U1Submissions implements D.PrinterSubmissions {
  private entries = new Map<string, Entry>();
  private admissions = new Map<string, { signature: string; result: Promise<D.Result<D.PrintSubmissionRef>> }>();
  constructor(private readonly dependencies: Dependencies) {}
  prepare: D.PrinterSubmissions['prepare'] = (request, options) => this.dependencies.prepare(request, options);

  submit: D.PrinterSubmissions['submit'] = async (request, artifacts) => {
    try {
      request = copy(request);
      artifacts = artifacts.map(artifact => ({ ...artifact }));
      const key = JSON.stringify([request.target.printerId, request.target.routeId, request.requestId]);
      const signature = requestSignature([request, artifacts.map(({ role, fileName, sizeBytes }) => ({ role, fileName, sizeBytes }))]);
      const prior = this.admissions.get(key);
      if (prior) {
        if (prior.signature !== signature) fail('invalid-request', 'Request identity was already used');
        return copy(await prior.result);
      }
      const result = this.admit(request, artifacts);
      this.admissions.set(key, { signature, result });
      return copy(await result);
    } catch (error) { return { ok: false, error: { ...publicError(error), message: U1_SEND_FAILURE } }; }
  };
  private async admit(request: D.PrintSubmissionRequest, artifacts: readonly D.PrintArtifactSource[]): Promise<D.Result<D.PrintSubmissionRef>> {
    try {
      if (artifacts.length !== 1 || artifacts[0].role !== 'print') fail('invalid-request', 'U1 requires one unchanged G-code artifact');
      const artifact = artifacts[0];
      if (!artifact.fileName || /[\0\r\n/\\]/.test(artifact.fileName) || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0 || artifact.sizeBytes > 0x7fffffff)
        fail('invalid-request', 'Invalid artifact name or size');
      const resolved = await this.dependencies.resolve(request.target);
      // A local mapping/start transaction cannot interleave with another local
      // submission to this printer. This is not a printer busy/idle-state gate.
      if ([...this.entries.values()].some(entry => entry.value.ref.printerId === request.target.printerId && !terminal(entry.value.phase)))
        fail('busy', 'Another local submission is unfinished');
      request.target = { ...request.target, expectedConfigurationRevision: resolved.revision };
      const ref: D.PrintSubmissionRef = { printerId: request.target.printerId, routeId: request.target.routeId, id: newId<'print-submission'>() };
      const entry: Entry = { value: { ref, requestId: request.requestId, phase: 'staging', route: 'lan', progress: null,
        message: 'Preparing print submission', canCancel: true }, revision: 0, listeners: new Set(), abort: new AbortController(),
        evidence: { remoteFileMayExist: false, preparationAcknowledged: 0, startDispatched: false, startAcknowledged: false, outcomeUnknown: false } };
      this.entries.set(ref.id, entry);
      void this.execute(entry, request, { ...artifact }, resolved.printer);
      return { ok: true, value: ref };
    } catch (error) { return { ok: false, error: { ...publicError(error), message: U1_SEND_FAILURE } }; }
  }
  private update(entry: Entry, patch: Partial<D.PrintSubmissionState>) {
    entry.value = { ...entry.value, ...patch }; entry.revision++;
    for (const notify of entry.listeners) notify();
  }
  private check(entry: Entry) { if (entry.abort.signal.aborted) fail('cancelled', 'Sending cancelled'); }
  private async validate(entry: Entry, request: D.PrintSubmissionRequest) {
    this.check(entry);
    const prepared = await this.prepare({ ...request, suggest: false, autoMatch: false, checkRecording: true }, { signal: entry.abort.signal });
    this.check(entry);
    if (!prepared.ok) throw new MoonrakerFailure(prepared.error);
    if (prepared.value.issues.some(issue => issue.severity === 'block' || issue.severity === 'warning' && !request.acknowledgedIssues.includes(issue.id)))
      fail('precondition-failed', 'Print preparation requires review');
    return prepared.value;
  }
  private async execute(entry: Entry, request: D.PrintSubmissionRequest, artifact: D.PrintArtifactSource, printer: PrinterConfiguration) {
    let release: (() => void) | undefined;
    try {
      release = await this.dependencies.retainObservation?.(request.target);
      await this.validate(entry, request);
      const bytes = await collectArtifact(artifact, entry.abort.signal);
      await this.dependencies.resolve(request.target); this.check(entry);
      this.update(entry, { phase: 'sending', message: 'Uploading G-code' });
      entry.evidence.remoteFileMayExist = true;
      const path = await this.dependencies.http.upload(printer, artifact.fileName, bytes, entry.abort.signal, progress => {
        if (!entry.abort.signal.aborted) this.update(entry, { progress: progress.total ? Math.min(1, progress.loaded / progress.total) : null });
      });
      this.check(entry);
      // Recheck live structured data after a potentially long upload. This is
      // not a settings readback and never inspects the uploaded bytes.
      const prepared = await this.validate(entry, request);
      const commands = prepareU1Print({ usedFilamentIds: request.requirements.materials.map(m => m.index),
        bindings: request.requirements.materials.map(material => ({ filamentId: material.index,
          toolIndex: u1BindingHead(prepared.bindings.find(b => b.materialKey === material.key)!.pathId)! })),
        bedLeveling: prepared.options.bedLeveling !== 'off', flowCalibration: prepared.options.flowCalibration !== 'off',
        timelapse: prepared.options.timelapse === true, calibrationToolIndices: prepared.options.calibrationToolIndices }).commands;
      this.update(entry, { message: 'Applying print mapping and options', progress: null });
      for (const script of commands) {
        await this.dependencies.resolve(request.target); this.check(entry);
        await this.dependencies.http.post(printer, '/printer/gcode/script', { script });
        entry.evidence.preparationAcknowledged++;
        this.check(entry);
      }
      await this.dependencies.resolve(request.target); this.check(entry);
      // No await between the cancellation boundary and the actual dispatch.
      entry.evidence.startDispatched = true;
      this.update(entry, { canCancel: false, message: 'Sending print start' });
      await this.dependencies.http.post(printer, '/printer/print/start', { filename: path });
      entry.evidence.startAcknowledged = true;
      this.update(entry, { phase: 'sent', message: 'Print job sent', progress: 1, canCancel: false });
    } catch (error) {
      entry.evidence.outcomeUnknown = error instanceof MoonrakerFailure && error.uncertain;
      if (entry.abort.signal.aborted && !entry.evidence.startDispatched)
        this.update(entry, { phase: 'cancelled', canCancel: false, message: 'Sending cancelled. An uploaded file or applied settings may remain on the printer.' });
      else this.update(entry, { phase: 'failed', canCancel: false, message: U1_SEND_FAILURE });
    } finally { release?.(); }
  }
  private find(ref: D.PrintSubmissionRef) {
    const entry = this.entries.get(ref.id);
    if (!entry || entry.value.ref.printerId !== ref.printerId || entry.value.ref.routeId !== ref.routeId) fail('invalid-target', 'Submission not found');
    return entry;
  }
  get: D.PrinterSubmissions['get'] = async ref => {
    try { return { ok: true, value: copy(this.find(ref).value) }; } catch (error) { return { ok: false, error: publicError(error) }; }
  };
  cancel: D.PrinterSubmissions['cancel'] = async ref => {
    try {
      const entry = this.find(ref);
      if (entry.value.canCancel && !entry.evidence.startDispatched && !terminal(entry.value.phase)) {
        entry.abort.abort();
        this.update(entry, { phase: 'cancelling', canCancel: false, message: 'Cancelling sending' });
      }
      return { ok: true, value: copy(entry.value) };
    } catch (error) { return { ok: false, error: publicError(error) }; }
  };
  watch: D.PrinterSubmissions['watch'] = async function* (this: U1Submissions, ref: D.PrintSubmissionRef, options?: D.ReadOptions) {
    const entry = this.find(ref);
    let wake: (() => void) | undefined;
    const notify = () => wake?.();
    entry.listeners.add(notify); options?.signal?.addEventListener('abort', notify);
    let revision = -1;
    try {
      while (!options?.signal?.aborted) {
        if (revision !== entry.revision) {
          revision = entry.revision; const value = copy(entry.value); yield value;
          if (terminal(value.phase)) return;
        }
        if (revision === entry.revision && !options?.signal?.aborted) await new Promise<void>(resolve => { wake = resolve; });
        wake = undefined;
      }
    } finally { entry.listeners.delete(notify); options?.signal?.removeEventListener('abort', notify); }
  }.bind(this);
}

async function collectArtifact(source: D.PrintArtifactSource, signal: AbortSignal) {
  const bytes = new Uint8Array(source.sizeBytes);
  const iterator = source.chunks[Symbol.asyncIterator]();
  let offset = 0, cancel!: () => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new MoonrakerFailure({ code: 'cancelled', message: 'Sending cancelled' }));
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    if (signal.aborted) fail('cancelled', 'Sending cancelled');
    while (true) {
      const next = await Promise.race([iterator.next(), cancellation]);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || offset + next.value.length > bytes.length) fail('invalid-request', 'Artifact size differs from its declaration');
      bytes.set(next.value, offset); offset += next.value.length;
    }
    if (offset !== bytes.length) fail('invalid-request', 'Artifact size differs from its declaration');
    return bytes;
  } finally {
    signal.removeEventListener('abort', cancel);
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
}
