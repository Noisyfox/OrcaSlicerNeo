import type * as D from '@orca/printer-control/domain';
import type { BambuBridge } from '../../../shared/bambu';

/** Metadata crosses ordinary IPC; managed downloads execute against the utility reader. */
export function bambuFiles(bridge: BambuBridge): D.PrinterFiles {
  const read = async <T>(request: (readId: string) => Promise<D.Result<T>>, options?: D.ReadOptions): Promise<D.Result<T>> => {
    const cancelled = (): D.Result<T> => ({ ok: false, error: { code: 'cancelled', message: 'Storage reading was cancelled.' } });
    if (options?.signal?.aborted) return cancelled();
    const readId = crypto.randomUUID();
    const abort = () => { void bridge.control('storage.cancel', { readId }).catch(() => undefined); };
    options?.signal?.addEventListener('abort', abort, { once: true });
    try { const result = await request(readId); return options?.signal?.aborted ? cancelled() : result; }
    catch { return { ok: false, error: { code: 'transport', message: 'Printer storage is unavailable.' } }; }
    finally { options?.signal?.removeEventListener('abort', abort); }
  };
  const unsupported = { code: 'unsupported', message: 'This storage operation is not available yet.' } as const;
  return {
    listStorages: (target, options) => read(readId => bridge.control('storage.storages', { target, readId }), options),
    list: (request, options) => read(readId => bridge.control('storage.list', { request, readId }), options),
    stat: (file, options) => read(readId => bridge.control('storage.stat', { file, readId }), options),
    listPreviews: async () => ({ ok: false, error: unsupported }),
    download: async () => ({ ok: false, error: unsupported }),
    upload: async () => ({ kind: 'rejected', error: unsupported }),
    watchChanges: async function* () { throw Object.assign(new Error(unsupported.message), { detail: unsupported }); },
  };
}
