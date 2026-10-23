import { randomUUID } from 'node:crypto';
import type { NativeEvent } from '@orca/bambu-native';
import type * as D from '@orca/printer-control/domain';
import { commandBasis, prepareCommand, type PreparedCommand } from './commands';
import { BambuMonitor } from './monitor';
import { record, text } from './telemetry';
interface Tracked {
  operation: D.CommandOperation; request: D.CommandRequest; prepared: PreparedCommand;
  sequence: string; token: string; timer: ReturnType<typeof setTimeout>;
}
const failure = (code: D.ErrorCode, message: string) => ({ ok: false as const, error: { code, message } });
const terminal = (phase: D.CommandOperation['phase']) => ['completed', 'failed', 'outcome-unknown'].includes(phase.kind);
/** Instance-local request deduplication and immutable target-bound physical outcomes. */
export class BambuOperations {
  private readonly operations = new Map<string, Tracked>();
  private readonly requests = new Map<string, { fingerprint: string; result: Promise<D.Submission> }>();
  private sequence = 1000000;
  constructor(private readonly monitor: BambuMonitor, private readonly changed: () => void, private readonly timeoutMs = 30_000, private readonly now = () => Date.now()) {}
  async evaluate(target: D.PrinterTarget, command: D.PrinterCommand): Promise<D.Result<D.CommandEvaluation>> {
    const context = await this.monitor.context(target); if (!context.ok) return context;
    const result = prepareCommand(context.value, command);
    return { ok: true, value: { basis: commandBasis(context.value), availability: result.ok ? { kind: 'available' } : { kind: 'blocked', reasons: [result.error] } } };
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
      const result = await this.monitor.dispatch(request.target, async (context, send) => {
        if (request.target.expectedConfigurationRevision !== undefined && request.target.expectedConfigurationRevision !== context.configurationRevision) return failure('stale-context', 'Printer configuration changed.');
        const basis = commandBasis(context);
        for (const [key, expected] of Object.entries(request.guard ?? {})) if (expected !== undefined && expected !== basis[key as keyof typeof basis]) return failure('stale-context', 'Printer, task, or material context changed. Review the current state.');
        const prepared = prepareCommand(context, request.command); if (!prepared.ok) return prepared;
        const sequence = String(++this.sequence), operation: D.CommandOperation = { kind: 'command', commandType: request.command.type,
          ref: { ...context.target, id: randomUUID() as D.Id<'operation'> }, requestId: request.requestId,
          configurationRevision: context.configurationRevision, revision: 1, updatedAtMs: this.now(), phase: { kind: 'sent' } };
        const timer = setTimeout(() => { if (tracked && !terminal(tracked.operation.phase)) this.update(tracked, { kind: 'outcome-unknown', reason: 'The printer did not confirm completion. Check its current state before issuing another command.' }); }, this.timeoutMs); timer.unref();
        tracked = { operation, request, prepared: prepared.value, sequence, token: lease.value, timer };
        this.operations.set(operation.ref.id, tracked); this.changed();
        try {
          const code = await send(prepared.value.section, { ...prepared.value.fields, sequence_id: sequence }, prepared.value.qos);
          if (code !== 0 && !terminal(tracked.operation.phase)) this.update(tracked, { kind: 'outcome-unknown', reason: 'Transport did not confirm delivery. This command will not be resent.' });
        } catch { if (!terminal(tracked.operation.phase)) this.update(tracked, { kind: 'outcome-unknown', reason: 'The connection ended during dispatch. This command will not be resent.' }); }
        return { ok: true, value: operation.ref };
      });
      return result.ok ? { kind: 'recorded', operation: result.value } : { kind: 'rejected', error: result.error };
    } catch { return tracked ? { kind: 'outcome-unknown', lookup: { ...request.target, requestId: request.requestId } } : { kind: 'rejected', error: { code: 'transport', message: 'The command could not be prepared.' } }; }
    finally { if (!tracked) await this.monitor.stop(lease.value).catch(() => undefined); }
  }
  private update(tracked: Tracked, phase: D.CommandOperation['phase']) {
    if (terminal(tracked.operation.phase)) return;
    tracked.operation = { ...tracked.operation, phase, revision: tracked.operation.revision + 1, updatedAtMs: this.now() };
    if (terminal(phase)) { clearTimeout(tracked.timer); void this.monitor.stop(tracked.token).catch(() => undefined); }
    this.changed();
  }
  async onEvent(event: NativeEvent) {
    if (event.type !== 'message' && event.type !== 'local-message') return;
    let root: Record<string, unknown>; try { root = record(JSON.parse(event.args[1])); } catch { return; }
    for (const tracked of this.operations.values()) {
      const ref = tracked.operation.ref;
      if (terminal(tracked.operation.phase) || ref.printerId !== `bambu:${encodeURIComponent(event.args[0])}`
        || !ref.routeId.endsWith(event.type === 'message' ? ':cloud' : ':lan')) continue;
      const response = record(root[tracked.prepared.section]);
      if (text(response.sequence_id) === tracked.sequence && response.command === tracked.prepared.fields.command) {
        if (response.result === 'fail' || response.result === 'failed' || response.result === 'error') this.update(tracked, { kind: 'failed', error: { code: 'device-rejected', message: 'The printer rejected this command. Check the printer status.' } });
        else if (response.result === 'success') this.update(tracked, { kind: 'acknowledged' });
      }
      if (record(root.print).command === 'push_status' && tracked.prepared.confirmed) {
        const context = await this.monitor.context(ref);
        if (context.ok && context.value.fresh && context.value.configurationRevision === tracked.operation.configurationRevision && tracked.prepared.confirmed(context.value)) this.update(tracked, { kind: 'completed', result: null, confirmation: 'observed-state' });
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
  close() { for (const tracked of this.operations.values()) if (!terminal(tracked.operation.phase)) this.update(tracked, { kind: 'outcome-unknown', reason: 'This application instance closed before completion was confirmed.' }); }
}
