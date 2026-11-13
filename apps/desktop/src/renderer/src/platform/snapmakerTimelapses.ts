import type { U1TimelapseTransport } from '@orca/printer-control';
import type { Result } from '@orca/platform-contract';
import { cameraConfigurationDigest } from '../../../shared/snapmakerCamera';
import type { SnapmakerTimelapseBridge } from '../../../shared/snapmakerTimelapses';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw Object.assign(new Error(result.error.message), { detail: result.error });
  return result.value;
}

export function snapmakerTimelapses(bridge: SnapmakerTimelapseBridge): U1TimelapseTransport {
  return {
    canPlay: () => true,
    async list(printer, page, rows, signal) {
      const id = crypto.randomUUID(), configurationDigest = await cameraConfigurationDigest(printer);
      signal.throwIfAborted();
      const cancel = () => { void bridge.call('cancel', { id }).catch(() => undefined); };
      signal.addEventListener('abort', cancel, { once: true });
      try { return unwrap(await bridge.call('list', { id, printerId: printer.id, configurationDigest, page, rows })); }
      finally { signal.removeEventListener('abort', cancel); }
    },
    async open(printer, video, signal) {
      const configurationDigest = await cameraConfigurationDigest(printer);
      signal.throwIfAborted();
      const { id, url } = unwrap(await bridge.call('open', { printerId: printer.id, configurationDigest, video }));
      return { url, close: async () => { unwrap(await bridge.call('close', { id })); } };
    },
    async delete(printer, dateIndex, signal) {
      const configurationDigest = await cameraConfigurationDigest(printer);
      signal.throwIfAborted();
      return bridge.call('delete', { printerId: printer.id, configurationDigest, dateIndex });
    },
  };
}
