/** Host-lifetime operation records. Observers never own or cancel physical operations. */
import type { Id, PrinterOperation, OperationRef, RequestLookup, PrinterOperations, PrinterStreamError, ReadOptions, Submission } from './domain';
import { fail } from './moonraker-http';

export const newId = <K extends string>(): Id<K> => crypto.randomUUID() as Id<K>;
export const copy = <T>(value: T): T => structuredClone(value);
/** Property order is not part of the identity of a typed request. */
export function requestSignature(value: unknown): string {
  return JSON.stringify(value, (_key, next) => next && typeof next === 'object' && !Array.isArray(next)
    ? Object.fromEntries(Object.keys(next).sort().map(key => [key, next[key]])) : next);
}
export function streamError(message: string): PrinterStreamError {
  return Object.assign(new Error(message), { detail: { code: 'unsupported' as const, message } });
}
const key = (ref: RequestLookup) => JSON.stringify([ref.printerId, ref.routeId, ref.requestId]);
interface Entry {
  signature: string;
  value: PrinterOperation;
  listeners: Set<() => void>;
  cancel?: AbortController;
}
export class OperationStore {
  private entries = new Map<string, Entry>();
  private requests = new Map<string, string>();
  private entry(ref: OperationRef): Entry | undefined {
    const entry = this.entries.get(ref.id);
    return entry?.value.ref.printerId === ref.printerId && entry.value.ref.routeId === ref.routeId ? entry : undefined;
  }
  existing(request: RequestLookup, signature: string): Submission | undefined {
    const id = this.requests.get(key(request));
    const entry = id && this.entries.get(id);
    if (!entry) return;
    if (entry.signature !== signature) fail('invalid-request', 'Request identity was already used with different parameters');
    return { kind: 'recorded', operation: copy(entry.value.ref) };
  }
  register(value: PrinterOperation, signature: string, cancel?: AbortController): Submission {
    this.entries.set(value.ref.id, { value: copy(value), signature, listeners: new Set(), cancel });
    this.requests.set(key({ ...value.ref, requestId: value.requestId }), value.ref.id);
    return { kind: 'recorded', operation: copy(value.ref) };
  }
  update(ref: OperationRef, update: (previous: PrinterOperation) => PrinterOperation): void {
    const entry = this.entry(ref);
    if (!entry) return;
    entry.value = { ...update(copy(entry.value)), revision: entry.value.revision + 1, updatedAtMs: Date.now() };
    for (const listener of entry.listeners) listener();
  }
  readonly api: PrinterOperations = {
    get: async ref => ({ ok: true, value: this.entry(ref) ? { kind: 'found', operation: copy(this.entry(ref)!.value) } : { kind: 'unknown', reason: 'not-found' } }),
    find: async request => {
      const id = this.requests.get(key(request));
      return id ? this.api.get({ ...request, id: id as Id<'operation'> }) : { ok: true, value: { kind: 'unknown', reason: 'not-found' } };
    },
    watch: (ref, options) => this.watch(ref, options),
    requestUploadCancellation: async ref => {
      const entry = this.entry(ref);
      if (!entry) return { ok: false, error: { code: 'invalid-target', message: 'Operation not found' } };
      if (entry.value.kind !== 'upload') return { ok: false, error: { code: 'unsupported', message: 'Only uploads can be cancelled here' } };
      if (['completed', 'failed', 'cancelled', 'outcome-unknown'].includes(entry.value.phase.kind)) return { ok: true, value: { kind: 'already-finished' } };
      entry.cancel?.abort();
      return { ok: true, value: { kind: 'requested' } };
    },
  };
  private async *watch(ref: OperationRef, options?: ReadOptions): AsyncIterable<PrinterOperation> {
    const entry = this.entry(ref);
    if (!entry) throw Object.assign(new Error('Operation not found'), { detail: { code: 'invalid-target', message: 'Operation not found' } });
    let wake: (() => void) | undefined;
    const notify = () => wake?.();
    entry.listeners.add(notify);
    options?.signal?.addEventListener('abort', notify);
    let revision = -1;
    try {
      while (!options?.signal?.aborted) {
        if (entry.value.revision !== revision) {
          const value = copy(entry.value);
          revision = value.revision;
          yield value;
          // An acknowledgement is the final evidence offered by this request-only provider.
          if (['accepted', 'completed', 'failed', 'cancelled', 'outcome-unknown', 'acknowledged'].includes(value.phase.kind)) return;
        }
        if (entry.value.revision === revision && !options?.signal?.aborted) await new Promise<void>(resolve => { wake = resolve; });
        wake = undefined;
      }
    } finally {
      entry.listeners.delete(notify);
      options?.signal?.removeEventListener('abort', notify);
    }
  }
}
