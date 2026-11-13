import type * as D from '@orca/platform-contract';
import { isMediaPacket, type BambuMediaAttachment, type BambuMediaMessage } from '../../../shared/bambuMedia';
const failure = (code: D.ErrorCode, message: string): D.PrinterStreamError => Object.assign(new Error(message), { detail: { code, message } });

/** Bounded pull-based binary delivery shared by the desktop media providers. */
export function desktopMediaStream(channel: string, bridge: { connect(request: BambuMediaAttachment): void; close(ref: D.MediaRef): Promise<unknown> }): D.PrinterMedia['readStream'] {
  return async function* (request, options) {
    const token = crypto.randomUUID();
    let port: MessagePort | undefined, pending: BambuMediaMessage | undefined, closed = false, wake: (() => void) | undefined;
    let offered: ((value: MessagePort) => void) | undefined, rejected: ((error: Error) => void) | undefined;
    const offer = new Promise<MessagePort>((resolve, reject) => { offered = resolve; rejected = reject; });
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.data?.channel !== channel || event.data.token !== token || event.ports.length !== 1) return;
      if (options?.signal?.aborted) event.ports[0].close();
      offered!(event.ports[0]);
    };
    const abort = () => { closed = true; wake?.(); rejected?.(failure('cancelled', 'Camera viewing stopped.')); };
    const timeout = setTimeout(() => rejected?.(failure('transport', 'Camera channel unavailable.')), 5000);
    window.addEventListener('message', receive); options?.signal?.addEventListener('abort', abort);
    try {
      if (options?.signal?.aborted) return;
      bridge.connect({ ...request, token });
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
      await bridge.close(request.media).catch(() => {});
    }
  };
}
