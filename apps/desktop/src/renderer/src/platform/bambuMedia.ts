import type * as D from '@orca/printer-control/domain';
import type { BambuBridge } from '../../../shared/bambu';
import { isMediaPacket, type BambuMediaMessage } from '../../../shared/bambuMedia';
const failure = (code: D.ErrorCode, message: string): D.PrinterStreamError => Object.assign(new Error(message), { detail: { code, message } });
const unsupported = async (): Promise<D.Result<never>> => ({ ok: false, error: { code: 'unsupported', message: 'This camera operation is not supported.' } });

export function bambuMedia(bridge: BambuBridge): D.PrinterMedia {
  return {
    readCurrentPrintPreview: target => bridge.control('preview', target),
    open: async (request, options) => {
      const result = await bridge.media('open', request);
      if (options?.signal?.aborted && result.ok) { await bridge.media('close', result.value.ref); return { ok: false, error: { code: 'cancelled', message: 'Camera viewing stopped.' } }; }
      return result;
    },
    renew: ref => bridge.media('renew', ref), close: ref => bridge.media('close', ref),
    sendSignal: unsupported, readContent: unsupported, captureSnapshot: unsupported,
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
    readStream: async function* (request, options) {
      const token = crypto.randomUUID();
      let port: MessagePort | undefined, pending: BambuMediaMessage | undefined, closed = false, wake: (() => void) | undefined;
      let offered: ((value: MessagePort) => void) | undefined, rejected: ((error: Error) => void) | undefined;
      const offer = new Promise<MessagePort>((resolve, reject) => { offered = resolve; rejected = reject; });
      const receive = (event: MessageEvent) => {
        if (event.source !== window || event.data?.channel !== 'orca:bambu-media' || event.data.token !== token || event.ports.length !== 1) return;
        if (options?.signal?.aborted) event.ports[0].close();
        offered!(event.ports[0]);
      };
      const abort = () => { closed = true; wake?.(); rejected?.(failure('cancelled', 'Camera viewing stopped.')); };
      const timeout = setTimeout(() => rejected?.(failure('transport', 'Camera channel unavailable.')), 5000);
      window.addEventListener('message', receive); options?.signal?.addEventListener('abort', abort);
      try {
        if (options?.signal?.aborted) return;
        bridge.connectMedia({ ...request, token });
        port = await offer; clearTimeout(timeout); window.removeEventListener('message', receive); rejected = undefined;
        port.onmessage = ({ data }: MessageEvent<unknown>) => {
          const message = data as BambuMediaMessage;
          if (!message || typeof message !== 'object' || (message.type !== 'closed' && message.type !== 'error' && !(message.type === 'packet' && isMediaPacket(message.packet))) || pending) {
            pending = { type: 'error', error: { code: 'stream-gap', message: 'Camera delivery was interrupted.' } };
          } else pending = message;
          wake?.();
        };
        port.onmessageerror = () => { pending = { type: 'error', error: { code: 'stream-gap', message: 'Camera delivery was interrupted.' } }; wake?.(); };
        port.start();
        while (!closed) {
          port.postMessage('pull');
          if (!pending) await new Promise<void>(resolve => { wake = resolve; if (pending || closed) resolve(); });
          wake = undefined;
          if (closed) return;
          const message = pending!; pending = undefined;
          if (message.type === 'closed') return;
          if (message.type === 'error') throw failure(message.error.code, message.error.message);
          yield message.packet;
        }
      } catch (error) { if (!options?.signal?.aborted) throw error; }
      finally {
        clearTimeout(timeout); window.removeEventListener('message', receive); options?.signal?.removeEventListener('abort', abort); port?.close();
        // Bambu has one consumer; detachment ends that native view. close remains idempotent.
        await bridge.media('close', request.media).catch(() => {});
      }
    },
  };
}
