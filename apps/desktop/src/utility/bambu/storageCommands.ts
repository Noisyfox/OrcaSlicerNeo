import { randomUUID } from 'node:crypto';
import { BambuStorageError } from '@orca/bambu-native';
import type * as D from '@orca/platform-contract';
import { BambuStorageFiles, StorageHostError, storageFailure } from './storageFiles';
type DeleteRequest = Extract<D.CommandRequest, { command: D.CommandOf<'files.delete'> }>;
const rejected = (code: D.ErrorCode, message: string): D.Submission => ({ kind: 'rejected', error: { code, message } });
/** File mutations use CTRL directly, without a Monitor lease or local in-use veto. */
export class BambuStorageCommands {
  private readonly operations = new Map<string, D.CommandOperation>();
  private readonly active = new Set<Promise<void>>();
  private readonly shutdown = new AbortController();
  constructor(private readonly files: BambuStorageFiles, private readonly changed: () => void) {}
  async evaluate(target: D.PrinterTarget, command: D.CommandOf<'files.delete'>): Promise<D.Result<D.CommandEvaluation>> {
    const ref = command.params.target;
    if (target.printerId !== ref.printerId || target.routeId !== ref.routeId) return { ok: false, error: { code: 'invalid-target', message: 'The file belongs to a different printer route.' } };
    const resolved = await this.files.resolveFile(ref);
    return { ok: true, value: { basis: { capabilityRevision: 'bambu-storage-1' }, warnings: [],
      availability: resolved.ok ? { kind: 'available' } : { kind: 'blocked', reasons: [resolved.error] } } };
  }
  async submit(request: DeleteRequest): Promise<D.Submission> {
    if (this.shutdown.signal.aborted) return rejected('cancelled', 'Storage control is closing.');
    if (this.active.size >= 8) return rejected('busy', 'Wait for another storage operation to finish.');
    const ref = request.command.params.target;
    if (request.target.printerId !== ref.printerId || request.target.routeId !== ref.routeId) return rejected('invalid-target', 'The file belongs to a different printer route.');
    if (request.target.expectedConfigurationRevision !== undefined && request.target.expectedConfigurationRevision !== ref.configurationRevision)
      return rejected('stale-context', 'The printer configuration changed. Refresh storage.');
    if (request.guard?.capabilityRevision !== undefined && request.guard.capabilityRevision !== 'bambu-storage-1') return rejected('stale-context', 'Storage capabilities changed.');
    if (Object.keys(request.guard ?? {}).some(key => key !== 'capabilityRevision')) return rejected('invalid-request', 'This file command does not accept print or material guards.');
    const resolved = await this.files.resolveFile(ref); if (!resolved.ok) return { kind: 'rejected', error: resolved.error };
    if (this.shutdown.signal.aborted) return rejected('cancelled', 'Storage control is closing.');
    if (this.active.size >= 8) return rejected('busy', 'Wait for another storage operation to finish.');
    const operation: D.CommandOperation = { kind: 'command', commandType: 'files.delete',
      ref: { printerId: ref.printerId, routeId: ref.routeId, id: randomUUID() as D.Id<'operation'> }, requestId: request.requestId,
      configurationRevision: ref.configurationRevision, revision: 1, updatedAtMs: Date.now(), phase: { kind: 'sent' },
      steps: [{ label: resolved.value.address.name, phase: { kind: 'sent' } }] };
    this.operations.set(operation.ref.id, operation); this.changed();
    const work = (async () => {
      let phase: D.CommandOperation['phase'];
      try {
        await resolved.value.source.remove(resolved.value.file, this.shutdown.signal);
        this.files.invalidate(ref); phase = { kind: 'completed', result: null, confirmation: 'device-result' };
      } catch (error) {
        // Pre-dispatch identity/authorization failures and explicit printer rejections
        // are known failures. Transport/protocol errors never prove absence of deletion.
        phase = error instanceof StorageHostError || error instanceof BambuStorageError && error.code === 'device-rejected'
          ? { kind: 'failed', error: storageFailure(error) }
          : { kind: 'outcome-unknown', reason: 'Deletion was not confirmed. Refresh storage manually before taking further action.' };
      }
      this.operations.set(operation.ref.id, { ...operation, phase, steps: [{ ...operation.steps[0], phase }], revision: 2, updatedAtMs: Date.now() });
      const completed = [...this.operations.values()].filter(value => ['completed', 'failed', 'outcome-unknown'].includes(value.phase.kind));
      for (const old of completed.slice(0, Math.max(0, completed.length - 200))) this.operations.delete(old.ref.id);
      this.changed();
    })().finally(() => this.active.delete(work));
    this.active.add(work);
    return { kind: 'recorded', operation: operation.ref };
  }
  get(ref: D.OperationRef): D.OperationLookup {
    const operation = this.operations.get(ref.id);
    return operation && operation.ref.printerId === ref.printerId && operation.ref.routeId === ref.routeId
      ? { kind: 'found', operation: structuredClone(operation) } : { kind: 'unknown', reason: 'not-found' };
  }
  find(request: D.RequestLookup): D.OperationLookup {
    const operation = [...this.operations.values()].find(value => value.requestId === request.requestId && value.ref.printerId === request.printerId && value.ref.routeId === request.routeId);
    return operation ? this.get(operation.ref) : { kind: 'unknown', reason: 'not-found' };
  }
  async close() { this.shutdown.abort(); await Promise.allSettled([...this.active]); }
}
