import type * as D from '@orca/printer-control/domain';
import type { BambuBridge } from '../../../shared/bambu';
import { desktopMediaStream } from './desktopMediaStream';
const failure = (code: D.ErrorCode, message: string): D.PrinterStreamError => Object.assign(new Error(message), { detail: { code, message } });
const unsupported = async (): Promise<D.Result<never>> => ({ ok: false, error: { code: 'unsupported', message: 'This camera operation is not supported.' } });

export function bambuMedia(bridge: BambuBridge): D.PrinterMedia {
  return {
    readPrintObjectMap: async (contextRef, options) => {
      const stopped = (): D.Result<never> => ({ ok: false, error: { code: 'cancelled', message: 'Object map reading was cancelled.' } });
      if (options?.signal?.aborted) return stopped();
      const readId = crypto.randomUUID();
      const abort = () => { void bridge.control('cancelObjectRead', { readId }).catch(() => undefined); };
      options?.signal?.addEventListener('abort', abort, { once: true });
      try {
        const result = await bridge.control('objectMap', { contextRef, readId });
        return options?.signal?.aborted ? stopped() : result;
      } catch { return { ok: false, error: { code: 'transport', message: 'The object map could not be read.' } }; }
      finally { options?.signal?.removeEventListener('abort', abort); }
    },
    readCurrentPrintPreview: target => bridge.control('preview', target),
    open: async (request, options) => {
      const aborted = (): D.Result<never> => ({ ok: false, error: { code: 'cancelled', message: 'Media viewing stopped.' } });
      if (options?.signal?.aborted) return aborted();
      const abort = () => { void bridge.media('cancelOpen', { requestId: request.requestId }).catch(() => {}); };
      options?.signal?.addEventListener('abort', abort, { once: true });
      try {
        const result = await bridge.media('open', request);
        if (options?.signal?.aborted) { if (result.ok) await bridge.media('close', result.value.ref); return aborted(); }
        return result;
      } finally { options?.signal?.removeEventListener('abort', abort); }
    },
    renew: ref => bridge.media('renew', ref), close: ref => bridge.media('close', ref),
    sendSignal: unsupported, readContent: unsupported, captureSnapshot: unsupported, interact: unsupported,
    watch: async function* (ref, options) {
      let version = 0, wake: (() => void) | undefined, sequence = 0, revision = -1;
      const changed = () => { version++; wake?.(); };
      const stop = bridge.onChanged(change => { if (change === 'media') changed(); });
      options?.signal?.addEventListener('abort', changed);
      try {
        while (!options?.signal?.aborted) {
          const before = version, result = await bridge.media('get', ref);
          if (options?.signal?.aborted) return;
          if (!result.ok) throw failure(result.error.code, result.error.message);
          const value = result.value;
          if (value.descriptor.revision !== revision) { revision = value.descriptor.revision; yield { sequence: sequence++, payload: { type: 'descriptor', descriptor: value.descriptor } }; }
          if (value.error) yield { sequence: sequence++, payload: { type: 'error', error: value.error } };
          if (value.state === 'closed') { yield { sequence: sequence++, payload: { type: 'closed', reason: value.error ? 'error' : 'client' } }; return; }
          yield { sequence: sequence++, payload: { type: 'state', state: value.state } };
          if (version === before && !options?.signal?.aborted) await new Promise<void>(resolve => { wake = resolve; if (version !== before || options?.signal?.aborted) resolve(); });
          wake = undefined;
        }
      } finally { stop(); options?.signal?.removeEventListener('abort', changed); }
    },
    readStream: desktopMediaStream('orca:bambu-media', { connect: request => bridge.connectMedia(request),
      close: ref => ref.id.startsWith('storage-video:') ? Promise.resolve() : bridge.media('close', ref) }),
  };
}
