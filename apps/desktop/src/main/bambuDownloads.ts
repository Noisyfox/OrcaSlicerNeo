/** Initial provider registration; all scheduling, saving and task UI remain generic. */
import { randomUUID } from 'node:crypto';
import type { DownloadBinding } from './printerDownloads';
import type { DownloadRecovery } from '../utility/downloadFiles';
import type { BambuUtility } from './bambuUtility';
import { savedBambuPrinter } from '../shared/bambuPrinters';
export function bambuDownloadBinding(host: BambuUtility, journalRoot: string, recovery: (result: DownloadRecovery) => void = () => {}): DownloadBinding {
  const initialized = host.host('download.initialize', { root: journalRoot, parentPid: process.pid }).then(result => {
    if (result.failed || result.ignored) recovery(result);
  });
  void initialized.catch(() => recovery({ cleaned: 0, failed: 1, ignored: 0 }));
  return {
    async resolve(file) {
      if (!file.printerId.startsWith('bambu:')) return { ok: false, error: { code: 'unsupported', message: 'Not a Bambu printer.' } };
      const devices = await host.read('printers.saved'); if (!devices.ok) return devices;
      const printer = devices.value.map(savedBambuPrinter).find(printer => printer.identity.id === file.printerId);
      const route = printer?.routes.find(route => route.id === file.routeId);
      if (!printer || !route) return { ok: false, error: { code: 'invalid-target', message: 'This printer is no longer available.' } };
      if (route.configurationRevision !== file.configurationRevision) return { ok: false, error: { code: 'stale-context', message: 'The printer configuration changed. Refresh storage.' } };
      return { ok: true, value: { physicalPrinterKey: printer.identity.id } };
    },
    async execute(file, destination, signal, progress) {
      await initialized;
      const id = randomUUID(), stop = host.onDownloadProgress((task, value) => { if (task === id) progress(value); });
      const cancel = () => { void host.host('download.cancel', { id }).catch(() => undefined); };
      signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
      try { return await host.host('download.run', { id, file, destination }); }
      finally { signal.removeEventListener('abort', cancel); stop(); }
    },
  };
}
