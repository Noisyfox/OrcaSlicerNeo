import { randomUUID } from 'node:crypto';
import { readU1Download, u1DownloadChunkBytes, u1DownloadSource } from '@orca/printer-control';
import type { PrinterConfigurationDocument, RemoteFileRef } from '@orca/platform-contract';
import { DownloadExecutor } from '../utility/downloadExecutor';
import type { DownloadRecovery } from '../utility/downloadFiles';
import type { DownloadBinding } from './printerDownloads';

export function snapmakerDownloadBinding(load: () => Promise<PrinterConfigurationDocument>, journalRoot: string,
  report: (result: DownloadRecovery) => void) {
  const lookup = async (file: RemoteFileRef) => (await load()).printers.find(printer => printer.driverId === 'snapmaker' && printer.id === file.printerId);
  const missing = { ok: false, error: { code: 'invalid-target', message: 'This printer is no longer configured.' } } as const;
  const progress = new Map<string, Parameters<DownloadBinding['execute']>[3]>();
  const executor = new DownloadExecutor(async (request, options) => {
    const printer = await lookup(request.target);
    return printer ? readU1Download(printer, request, options) : missing;
  }, u1DownloadChunkBytes, (id, value) => progress.get(id)?.(value));
  void executor.initialize(journalRoot, process.pid).then(report, () => report({ cleaned: 0, failed: 1, ignored: 0 }));
  const binding: DownloadBinding = {
    async resolve(file) {
      if (!file.routeId.startsWith('snapmaker:')) return { ok: false, error: { code: 'unsupported', message: 'Not a Snapmaker route.' } };
      const printer = await lookup(file);
      if (!printer) return missing;
      const source = await u1DownloadSource(printer, file);
      return source.ok ? { ok: true, value: { physicalPrinterKey: `snapmaker:${printer.id}` } } : source;
    },
    async execute(file, destination, signal, onProgress) {
      const id = randomUUID();
      const cancel = () => executor.cancel(id);
      progress.set(id, onProgress);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      try { return await executor.run(id, file, destination); }
      finally { progress.delete(id); signal.removeEventListener('abort', cancel); }
    },
  };
  return { binding, close: () => executor.close() };
}
