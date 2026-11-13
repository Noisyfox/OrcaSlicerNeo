import type * as D from '@orca/platform-contract';
import type { PrinterConfiguration } from '@orca/platform-contract';
import { cameraConfigurationDigest, type SnapmakerCameraBridge } from '../../../shared/snapmakerCamera';
import { desktopMediaStream } from './desktopMediaStream';

/** Renderer facade carries metadata and consumer-owned bytes through dedicated IPC. */
export function snapmakerCamera(bridge: SnapmakerCameraBridge,
  resolve: (target: D.TargetRequest) => Promise<{ printer: Readonly<PrinterConfiguration>; revision: D.Revision }>): Pick<D.PrinterMedia, 'open' | 'watch' | 'readStream' | 'renew' | 'interact' | 'close'> {
  return {
    open: async (request, options) => {
      const cancelled = (): D.Result<never> => ({ ok: false, error: { code: 'cancelled', message: 'Camera viewing stopped.' } });
      if (options?.signal?.aborted) return cancelled();
      const abort = () => { void bridge.call('cancelOpen', { requestId: request.requestId }).catch(() => undefined); };
      options?.signal?.addEventListener('abort', abort, { once: true });
      try {
        const current = await resolve(request.target), digest = await cameraConfigurationDigest(current.printer);
        if (options?.signal?.aborted) return cancelled();
        const result = await bridge.call('open', { request: { ...request, target: { ...request.target, expectedConfigurationRevision: current.revision } }, configurationDigest: digest });
        if (options?.signal?.aborted) { if (result.ok) await bridge.call('close', result.value.ref); return cancelled(); }
        return result;
      } catch { return { ok: false, error: { code: 'transport', message: 'Camera access unavailable.' } }; }
      finally { options?.signal?.removeEventListener('abort', abort); }
    },
    renew: ref => bridge.call('renew', ref), interact: ref => bridge.call('interact', ref), close: ref => bridge.call('close', ref),
    readStream: desktopMediaStream('orca:snapmaker-camera', { connect: request => bridge.connect(request), close: ref => bridge.call('close', ref) }),
    watch: async function* (ref, options) {
      let version = 0, wake: (() => void) | undefined, sequence = 0, revision = -1;
      const changed = () => { version++; wake?.(); };
      const unsubscribe = bridge.onChanged(changed);
      options?.signal?.addEventListener('abort', changed);
      try {
        while (!options?.signal?.aborted) {
          const before = version, result = await bridge.call('get', ref);
          if (options?.signal?.aborted) return;
          if (!result.ok) throw Object.assign(new Error(result.error.message), { detail: result.error });
          const value = result.value;
          if (value.descriptor.revision !== revision) { revision = value.descriptor.revision; yield { sequence: sequence++, payload: { type: 'descriptor', descriptor: value.descriptor } }; }
          if (value.error) yield { sequence: sequence++, payload: { type: 'error', error: value.error } };
          if (value.state === 'closed') { yield { sequence: sequence++, payload: { type: 'closed', reason: value.error ? 'error' : 'client' } }; return; }
          yield { sequence: sequence++, payload: { type: 'state', state: value.state } };
          if (version === before && !options?.signal?.aborted) await new Promise<void>(resolve => { wake = resolve; if (version !== before || options?.signal?.aborted) resolve(); });
          wake = undefined;
        }
      } finally { unsubscribe(); options?.signal?.removeEventListener('abort', changed); }
    },
  };
}
