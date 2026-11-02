import type { PreparedCommand } from './controlContext';
import { randomUUID } from 'node:crypto';
import type { NativeEvent } from '@orca/bambu-native';
import type * as D from '@orca/printer-control/domain';
import { commandBasis, prepareCommand } from './commands';
import { BambuMonitor } from './monitor';
import { record, text } from './protocol';
interface Tracked {
  operation: D.CommandOperation; request: D.CommandRequest; prepared: PreparedCommand;
  generation: number; sequences: string[]; dispatching: boolean; token: string; timer: ReturnType<typeof setTimeout>;
}
const failure = (code: D.ErrorCode, message: string) => ({ ok: false as const, error: { code, message } });
const terminal = (phase: { kind: string }) => ['accepted', 'completed', 'failed', 'outcome-unknown', 'not-sent'].includes(phase.kind);
// Firmware material workflows include warm-up, feed and wiping, which take minutes.
const completionTimeout = (command: D.PrinterCommand) =>
  ['materials.load', 'materials.switch', 'materials.unload'].includes(command.type) ? 10 * 60_000 : 30_000;
/** Instance-local request deduplication and immutable target-bound physical outcomes. */
export class BambuOperations {
  private readonly operations = new Map<string, Tracked>();
  private readonly requests = new Map<string, { fingerprint: string; result: Promise<D.Submission> }>();
  private sequence = 1000000;
  constructor(private readonly monitor: BambuMonitor, private readonly changed: () => void,
    private readonly timeoutMs: number | ((command: D.PrinterCommand) => number) = completionTimeout, private readonly now = () => Date.now()) {}
  async evaluate(target: D.PrinterTarget, command: D.PrinterCommand): Promise<D.Result<D.CommandEvaluation>> {
    const context = command.type === 'materials.configure' ? await this.monitor.prepareMaterials(target, command.params) : await this.monitor.context(target); if (!context.ok) return context;
    const result = prepareCommand(context.value, command);
    return { ok: true, value: { basis: commandBasis(context.value), warnings: result.ok ? result.value.warnings : [], availability: result.ok ? { kind: 'available' } : { kind: 'blocked', reasons: [result.error] } } };
  }
  submit(request: D.CommandRequest): Promise<D.Submission> {
    const key = JSON.stringify([request.target.printerId, request.target.routeId, request.requestId]);
    const fingerprint = JSON.stringify(request), previous = this.requests.get(key);
    if (previous) return previous.fingerprint === fingerprint ? previous.result : Promise.resolve({ kind: 'rejected', error: { code: 'invalid-request', message: 'This request ID was already used for a different command.' } });
    const result = this.submitNew(structuredClone(request)); this.requests.set(key, { fingerprint, result }); return result;
  }
  private async submitNew(request: D.CommandRequest): Promise<D.Submission> {
    const lease = await this.monitor.acquire(request.target);
    if (!lease.ok) return { kind: 'rejected', error: lease.error };
    let tracked: Tracked | undefined;
    try {
      if (request.command.type === 'materials.configure') {
        const ready = await this.monitor.prepareMaterials(request.target, request.command.params);
        if (!ready.ok) return { kind: 'rejected', error: ready.error };
      }
      const result = await this.monitor.dispatch(request.target, async (context, send) => {
        if (request.target.expectedConfigurationRevision !== undefined && request.target.expectedConfigurationRevision !== context.configurationRevision) return failure('stale-context', 'Printer configuration changed.');
        const basis = commandBasis(context);
        for (const [key, expected] of Object.entries(request.guard ?? {})) if (expected !== undefined && expected !== basis[key as keyof typeof basis]) return failure('stale-context', 'Printer, task, or material context changed. Review the current state.');
        const prepared = prepareCommand(context, request.command); if (!prepared.ok) return prepared;
        const acknowledged = request.command.type === 'materials.configure' ? request.command.params.acknowledgedWarningIds : [];
        if (prepared.value.warnings.some(warning => !acknowledged.includes(warning.id)))
          return failure('precondition-failed', 'Review and acknowledge the current material warnings before applying.');
        const sequences = prepared.value.commands.map(() => String(++this.sequence)), operation = { kind: 'command', commandType: request.command.type,
          ref: { ...context.target, id: randomUUID() as D.Id<'operation'> }, requestId: request.requestId,
          configurationRevision: context.configurationRevision, revision: 1, updatedAtMs: this.now(), phase: { kind: 'sent' },
          steps: prepared.value.commands.map(command => ({ label: command.label, phase: { kind: 'queued' } })) } as D.CommandOperation;
        const timeout = typeof this.timeoutMs === 'number' ? this.timeoutMs : this.timeoutMs(request.command);
        const timer = setTimeout(() => { if (tracked) this.endUnconfirmed(tracked, 'The printer did not confirm completion. Check its current state before issuing another command.'); }, timeout); timer.unref();
        tracked = { generation: context.generation, operation, request, prepared: prepared.value, sequences, dispatching: true, token: lease.value, timer };
        this.operations.set(operation.ref.id, tracked); this.changed();
        for (const [index, command] of prepared.value.commands.entries()) {
          if (tracked.operation.steps[index].phase.kind !== 'queued') continue;
          this.step(tracked, index, { kind: 'sent' });
          let sent = false;
          try { sent = await send(command.section, { ...command.fields, sequence_id: sequences[index] }, command.qos) === 0; }
          catch { /* Delivery is uncertain; never infer that the physical effect was absent. */ }
          if (!sent) {
            this.step(tracked, index, { kind: 'outcome-unknown', reason: 'Transport did not confirm delivery. This command will not be resent.' });
            if (!prepared.value.continueOnFailure) {
              for (let rest = index + 1; rest < prepared.value.commands.length; ++rest)
                this.step(tracked, rest, { kind: 'not-sent', reason: 'A preceding command could not be delivered.' });
              break;
            }
          }
        }
        tracked.dispatching = false;
        this.publish(tracked);
        return { ok: true, value: operation.ref };
      });
      return result.ok ? { kind: 'recorded', operation: result.value } : { kind: 'rejected', error: result.error };
    } catch { return tracked ? { kind: 'outcome-unknown', lookup: { ...request.target, requestId: request.requestId } } : { kind: 'rejected', error: { code: 'transport', message: 'The command could not be prepared.' } }; }
    finally { if (!tracked) await this.monitor.stop(lease.value).catch(() => undefined); }
  }
  private step(tracked: Tracked, index: number, phase: D.CommandStepPhase) {
    if (terminal(tracked.operation.phase) || terminal(tracked.operation.steps[index].phase)) return;
    tracked.operation = { ...tracked.operation, steps: tracked.operation.steps.map((step, i) => i === index ? { ...step, phase } : step) };
    this.publish(tracked);
  }
  private publish(tracked: Tracked) {
    if (terminal(tracked.operation.phase)) return;
    const steps = tracked.operation.steps;
    let phase: D.CommandOperation['phase'] = { kind: steps.some(step => step.phase.kind === 'acknowledged') ? 'acknowledged' : 'sent' };
    if (!tracked.dispatching && steps.every(step => terminal(step.phase))) {
      const failed = steps.find(step => step.phase.kind === 'failed');
      const uncertain = steps.find(step => step.phase.kind === 'outcome-unknown' || step.phase.kind === 'not-sent');
      const details = steps.map(step => `${step.label}: ${step.phase.kind === 'failed' ? step.phase.error.message
        : 'reason' in step.phase ? step.phase.reason : step.phase.kind === 'completed' ? 'Confirmed.' : 'Accepted; state not confirmed.'}`).join(' ');
      phase = failed?.phase.kind === 'failed' ? { kind: 'failed', error: { ...failed.phase.error, message: details } }
        : uncertain ? { kind: 'outcome-unknown', reason: details }
        : steps.every(step => step.phase.kind === 'completed') ? { kind: 'completed', result: null,
          confirmation: steps.every(step => step.phase.kind === 'completed' && step.phase.confirmation === 'device-result') ? 'device-result' : 'observed-state' }
        : { kind: 'accepted' };
    }
    tracked.operation = { ...tracked.operation, phase, revision: tracked.operation.revision + 1, updatedAtMs: this.now() };
    if (terminal(phase)) { clearTimeout(tracked.timer); void this.monitor.stop(tracked.token).catch(() => undefined); }
    this.changed();
  }
  private endUnconfirmed(tracked: Tracked, reason: string) {
    if (terminal(tracked.operation.phase)) return;
    tracked.dispatching = false;
    for (let index = 0; index < tracked.operation.steps.length; ++index) {
      const phase = tracked.operation.steps[index].phase;
      if (!terminal(phase)) this.step(tracked, index, phase.kind === 'queued' ? { kind: 'not-sent', reason } : { kind: 'outcome-unknown', reason });
    }
    this.publish(tracked);
  }
  async onEvent(event: NativeEvent) {
    if (event.type !== 'message' && event.type !== 'local-message') return;
    let root: Record<string, unknown>; try { root = record(JSON.parse(event.args[1])); } catch { return; }
    for (const tracked of this.operations.values()) {
      const ref = tracked.operation.ref;
      if (terminal(tracked.operation.phase) || ref.printerId !== `bambu:${encodeURIComponent(event.args[0])}`) continue;
      for (const [index, command] of tracked.prepared.commands.entries()) {
        if (tracked.operation.steps[index].phase.kind === 'queued') continue;
        const response = record(root[command.section]);
        if (text(response.sequence_id) === tracked.sequences[index] && response.command === command.fields.command) {
          const result = text(response.result)?.toLowerCase();
          if (result === 'fail' || result === 'failed' || result === 'error') this.step(tracked, index, { kind: 'failed', error: { code: 'device-rejected', message: 'The printer rejected this command. Check the printer status.' } });
          else if (command.responseConfirmed?.(response)) this.step(tracked, index, { kind: 'completed', result: null, confirmation: 'device-result' });
          else if (result === 'success') this.step(tracked, index, { kind: command.confirmed ? 'acknowledged' : 'accepted' });
        }
        if (record(root.print).command === 'push_status' && command.confirmed) {
          const context = await this.monitor.context(ref);
          if (context.ok && context.value.fresh && context.value.generation > tracked.generation && context.value.configurationRevision === tracked.operation.configurationRevision && command.confirmed(context.value))
            this.step(tracked, index, { kind: 'completed', result: null, confirmation: 'observed-state' });
        }
      }
    }
  }
  get(ref: D.OperationRef): D.Result<D.OperationLookup> {
    const tracked = this.operations.get(ref.id);
    return { ok: true, value: tracked && tracked.operation.ref.printerId === ref.printerId && tracked.operation.ref.routeId === ref.routeId
      ? { kind: 'found', operation: structuredClone(tracked.operation) } : { kind: 'unknown', reason: 'not-found' } };
  }
  find(request: D.RequestLookup): D.Result<D.OperationLookup> {
    const tracked = [...this.operations.values()].find(value => value.operation.requestId === request.requestId && value.operation.ref.printerId === request.printerId && value.operation.ref.routeId === request.routeId);
    return tracked ? this.get(tracked.operation.ref) : { ok: true, value: { kind: 'unknown', reason: 'not-found' } };
  }
  close() { for (const tracked of this.operations.values()) this.endUnconfirmed(tracked, 'This application instance closed before completion was confirmed.'); }
}
