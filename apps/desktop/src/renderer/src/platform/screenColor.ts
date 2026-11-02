import { createBrowserScreenColorSampler, normalizeScreenColorResult, type ScreenColorSources } from '@orca/platform-contract';
import type { ElectronBridge } from '../../../shared/ipc';

export function createElectronScreenColorSources(host: ElectronBridge['screenColor'], nativeAvailable: boolean): ScreenColorSources {
  return {
    browser: createBrowserScreenColorSampler(),
    native: nativeAvailable ? {
      async pick(signal) {
        if (signal.aborted) return { status: 'cancelled' };
        const id = `screen-color-${crypto.randomUUID()}`;
        const abort = () => { void host.cancel(id).catch(() => {}); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          const result = await host.pick(id);
          return signal.aborted ? { status: 'cancelled' } : normalizeScreenColorResult(result);
        } catch { return { status: signal.aborted ? 'cancelled' : 'failed' }; }
        finally { signal.removeEventListener('abort', abort); }
      },
    } : null,
  };
}
