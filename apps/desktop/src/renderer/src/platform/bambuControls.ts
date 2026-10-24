import type * as D from '@orca/printer-control/domain';
import type { BambuBridge } from '../../../shared/bambu';
import { isBambuCommandPayload } from '../../../shared/bambuCommandValidation';
import { isBambuControlRequest } from '../../../shared/bambuControl';
const unsupported = { code: 'unsupported', message: 'This command is not supported by Bambu control.' } as const;
export function bambuControls(bridge: BambuBridge): D.PrinterControls {
  return {
    evaluate: async (target, command) => {
      if (!isBambuCommandPayload(command)) return { ok: false, error: unsupported };
      try { return await bridge.control('evaluate', { target, command }); }
      catch { return { ok: false, error: { code: 'transport', message: 'Printer control is unavailable.' } }; }
    },
    submit: async request => {
      if (!isBambuCommandPayload(request.command)) return { kind: 'rejected', error: unsupported };
      if (!isBambuControlRequest({ method: 'submit', input: request })) return { kind: 'rejected', error: { code: 'invalid-request', message: 'Invalid printer command.' } };
      try { return await bridge.control('submit', request); }
      catch { return { kind: 'outcome-unknown', lookup: { printerId: request.target.printerId, routeId: request.target.routeId, requestId: request.requestId } }; }
    },
  };
}
export function bambuOperations(bridge: BambuBridge): D.PrinterOperations {
  return {
    get: async ref => { try { return await bridge.control('operation', ref); } catch { return { ok: true, value: { kind: 'unknown', reason: 'authority-unavailable' } }; } },
    find: async request => { try { return await bridge.control('find', request); } catch { return { ok: true, value: { kind: 'unknown', reason: 'authority-unavailable' } }; } },
    requestUploadCancellation: async () => ({ ok: false, error: unsupported }),
    watch: async function* (ref, options) {
      let version = 0, revision = 0; let wake: (() => void) | undefined;
      const stop = bridge.onChanged(change => { if (change === 'control') { ++version; wake?.(); } });
      const abort = () => wake?.(); options?.signal?.addEventListener('abort', abort);
      try {
        while (!options?.signal?.aborted) {
          const current = version; const result = await bridge.control('operation', ref);
          if (options?.signal?.aborted) return;
          if (!result.ok || result.value.kind !== 'found') throw new Error('The operation outcome is unavailable.');
          const operation = result.value.operation;
          if (operation.revision > revision) { revision = operation.revision; yield operation; }
          if (['accepted', 'completed', 'failed', 'outcome-unknown'].includes(operation.phase.kind)) return;
          if (current === version && !options?.signal?.aborted) await new Promise<void>(resolve => { wake = resolve; if (current !== version || options?.signal?.aborted) resolve(); });
        }
      } finally { stop(); options?.signal?.removeEventListener('abort', abort); }
    },
  };
}
