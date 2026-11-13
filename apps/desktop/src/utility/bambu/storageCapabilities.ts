import type * as D from '@orca/platform-contract';
import type { BambuDeviceAccess } from './deviceAccess';
import { StorageHostError, type BambuStorageCapabilities } from './storageFiles';

/** Storage visibility follows Studio's reported fun/fun2 flags, not volume discovery IDs. */
export async function readStorageCapabilities(access: Pick<BambuDeviceAccess, 'context' | 'read'>,
  target: D.PrinterTarget, signal?: AbortSignal, refresh = true): Promise<BambuStorageCapabilities> {
  const check = () => { if (signal?.aborted) throw new StorageHostError({ code: 'cancelled', message: 'Storage discovery was cancelled.' }); };
  check();
  let context = await access.context(target);
  // A temporary status read releases its own lease; never displace another monitored printer.
  // If status is unavailable, retain same-configuration reported capabilities or hide Internal.
  if (context.ok && !context.value.fresh && (refresh || context.value.report.fun === undefined && context.value.report.fun2 === undefined)) {
    const read = await access.read({ target, topics: ['status'], source: 'device' });
    if (read.ok) context = { ok: true, value: read.value.context };
  }
  check();
  return { internalModel: context.ok && context.value.machine.internalModelStorage,
    internalTimelapse: context.ok && context.value.machine.internalRecording };
}
