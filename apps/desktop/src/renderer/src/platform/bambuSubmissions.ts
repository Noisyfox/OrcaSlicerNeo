import type * as D from '@orca/printer-control/domain';
import type { BambuBridge } from '../../../shared/bambu';
/** Upload chunks are acknowledged one at a time; large archives never enter JSON arrays. */
export function bambuSubmissions(bridge: BambuBridge): D.PrinterSubmissions {
  const service: D.PrinterSubmissions = {
    prepare: async request => { try { return await bridge.control('print.prepare', request); } catch { return { ok: false, error: { code: 'transport', message: 'Print preparation is unavailable.' } }; } },
    submit: async (request, artifacts) => {
      let admitted;
      try { admitted = await bridge.control('print.begin', { request, artifacts: artifacts.map(({ role, fileName, sizeBytes }) => ({ role, fileName, sizeBytes })) }); }
      catch { return { ok: false, error: { code: 'transport', message: 'Submission admission could not be confirmed.' } }; }
      if (!admitted.ok) return admitted;
      const { ref, created } = admitted.value;
      if (created) void (async () => {
        try {
          for (const artifact of artifacts) {
            let offset = 0;
            for await (const bytes of artifact.chunks) {
              for (let index = 0; index < bytes.length; index += 256 * 1024) {
                const chunk = bytes.slice(index, index + 256 * 1024);
                const result = await bridge.control('print.chunk', { ref, role: artifact.role, offset, bytes: chunk });
                if (!result.ok) throw new Error('Artifact transfer failed');
                offset += chunk.length;
              }
            }
            if (offset !== artifact.sizeBytes) throw new Error('Artifact size differs');
          }
          const committed = await bridge.control('print.commit', ref);
          if (!committed.ok) throw new Error('Artifact commit failed');
        } catch { await bridge.control('print.cancel', ref).catch(() => undefined); }
      })();
      return { ok: true, value: ref };
    },
    get: async ref => { try { return await bridge.control('print.get', ref); } catch { return { ok: false, error: { code: 'transport', message: 'Submission outcome is unavailable.' } }; } },
    cancel: async ref => { try { return await bridge.control('print.cancel', ref); } catch { return { ok: false, error: { code: 'transport', message: 'Cancellation could not be confirmed.' } }; } },
    watch: async function* (ref, options) {
      let version = 0; let wake: (() => void) | undefined;
      const stop = bridge.onChanged(change => { if (change === 'control') { version++; wake?.(); } });
      const abort = () => wake?.(); options?.signal?.addEventListener('abort', abort);
      try {
        while (!options?.signal?.aborted) {
          const current = version, result = await service.get(ref);
          if (options?.signal?.aborted) return;
          if (!result.ok) throw new Error(result.error.message);
          yield result.value;
          if (['started', 'failed', 'cancelled', 'unknown'].includes(result.value.phase)) return;
          if (current === version) await new Promise<void>(resolve => { wake = resolve; if (current !== version || options?.signal?.aborted) resolve(); });
        }
      } finally { stop(); options?.signal?.removeEventListener('abort', abort); }
    },
  };
  return service;
}
