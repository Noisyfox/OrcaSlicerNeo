import type * as D from '@orca/printer-control/domain';
import type { BambuBridge } from '../../../shared/bambu';
const failure = (detail: D.PrinterError): D.PrinterStreamError => Object.assign(new Error(detail.message), { detail });
function scoped<K extends D.StateTopic>(value: D.PrinterSnapshot, request: D.ObservationRequest<K>): D.PrinterSnapshot<K> {
  if (value.target.printerId !== request.target.printerId || value.target.routeId !== request.target.routeId
    || request.topics.some(topic => value.values[topic] === undefined)) throw new Error('Mismatched observation response');
  return { target: value.target, configurationRevision: value.configurationRevision,
    values: Object.fromEntries(request.topics.map(topic => [topic, value.values[topic]])) as D.ObservationValues<K> };
}
/** Async iterators stay in the renderer; IPC carries normalized snapshots and opaque cleanup tokens. */
export function bambuObservations(bridge: BambuBridge): D.PrinterObservations {
  return {
    read: async <K extends D.StateTopic>(request: D.ObservationRequest<K> & { source: 'cache' | 'device' }, options?: D.ReadOptions) => {
      if (options?.signal?.aborted) return { ok: false, error: { code: 'cancelled', message: 'Status read cancelled.' } };
      try {
        const result = await bridge.control('read', request);
        if (options?.signal?.aborted) return { ok: false, error: { code: 'cancelled', message: 'Status read cancelled.' } };
        return result.ok ? { ok: true, value: scoped(result.value, request) } : result;
      } catch { return { ok: false, error: { code: 'transport', message: 'Printer status is unavailable.' } }; }
    },
    watch: async function* <K extends D.StateTopic>(request: D.ObservationRequest<K> & { after?: D.ObservationCursor }, options?: D.ReadOptions): AsyncIterable<D.PrinterEvent<K>> {
      if (options?.signal?.aborted) return;
      const token = crypto.randomUUID(); let version = 0; let cursor = 0; let wake: (() => void) | null = null;
      const stop = bridge.onChanged(change => { if (change === 'control' || change === 'printers') { ++version; wake?.(); } });
      const abort = () => wake?.(); options?.signal?.addEventListener('abort', abort);
      try {
        const opened = await bridge.control('observe', { target: request.target, token });
        if (!opened.ok) throw failure(opened.error);
        while (!options?.signal?.aborted) {
          const current = version;
          const snapshot = await bridge.control('read', { target: request.target, topics: request.topics, source: 'cache' });
          if (options?.signal?.aborted) return;
          if (!snapshot.ok) throw failure(snapshot.error);
          // A snapshot resets an unknown/expired cursor; no gap is represented as replay.
          yield { type: 'snapshot', cursor: `${token}:${++cursor}` as D.ObservationCursor, snapshot: scoped(snapshot.value, request) };
          if (current === version && !options?.signal?.aborted) await new Promise<void>(resolve => { wake = resolve; if (current !== version || options?.signal?.aborted) resolve(); });
          wake = null;
        }
      } catch (error) {
        if (!options?.signal?.aborted) throw error instanceof Error && 'detail' in error ? error : failure({ code: 'transport', message: 'Printer monitoring is unavailable.' });
      } finally {
        stop(); options?.signal?.removeEventListener('abort', abort);
        await bridge.control('release', { token }).catch(() => undefined);
      }
    },
  };
}
