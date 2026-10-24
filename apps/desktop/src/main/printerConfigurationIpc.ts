import {
  emptyPrinterConfigurationDocument,
  mergePrinterConfigurations,
  loadPrinterConfigurationFile,
  savePrinterConfigurationFile,
  type PrinterConfigurationFileSystem,
} from './printerConfigurationPersistence';
import { normalizePrinterConfigurationDocument, type PrinterConfigurationDocument } from '../../../../packages/printer-control/src/configuration';

export interface PrinterConfigurationIpcDependencies {
  path(): string;
  fs: PrinterConfigurationFileSystem;
  isCurrentRenderer(sender: unknown): boolean;
  transaction?<T>(work: () => Promise<T>): Promise<T>;
}

/** Main-process handlers with the sender policy kept explicit and testable. */
export function createPrinterConfigurationIpcHandlers(
  deps: PrinterConfigurationIpcDependencies,
) {
  const snapshots = new Map<unknown, PrinterConfigurationDocument>();
  return {
    async load(sender: unknown) {
      if (!deps.isCurrentRenderer(sender)) return emptyPrinterConfigurationDocument();
      const document = await loadPrinterConfigurationFile(deps.path(), deps.fs);
      snapshots.set(sender, document);
      return document;
    },
    async save(sender: unknown, document: unknown): Promise<void> {
      if (!deps.isCurrentRenderer(sender)) throw new Error('printer configuration IPC sender rejected');
      const next = normalizePrinterConfigurationDocument(document);
      const save = async () => {
        const base = snapshots.get(sender);
        const merged = base ? mergePrinterConfigurations(base, next, await loadPrinterConfigurationFile(deps.path(), deps.fs)) : next;
        await savePrinterConfigurationFile(deps.path(), merged, deps.fs);
        // The caller still holds next, so later edits must be diffed against that snapshot.
        snapshots.set(sender, next);
      };
      if (deps.transaction) await deps.transaction(save); else await save();
    },
  };
}
