import type { PrinterDownloads } from './domain';
/** Hosts without an execution/save binding explicitly expose an unsupported capability. */
export function unavailablePrinterDownloads(reason = 'Managed printer downloads are not available on this host.'): PrinterDownloads {
  const unavailable = async () => ({ ok: false as const, error: { code: 'unsupported' as const, message: reason } });
  return { capability: { kind: 'unsupported', layer: 'adapter', reason }, start: unavailable, list: unavailable,
    cancel: unavailable, retry: unavailable, continue: unavailable, open: unavailable, directory: unavailable,
    chooseDirectory: unavailable, saveDirectory: unavailable, onChanged: () => () => {} };
}
