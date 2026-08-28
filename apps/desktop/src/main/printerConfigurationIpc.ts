import {
  emptyPrinterConfigurationDocument,
  loadPrinterConfigurationFile,
  savePrinterConfigurationFile,
  type PrinterConfigurationFileSystem,
} from './printerConfigurationPersistence';

export interface PrinterConfigurationIpcDependencies {
  path(): string;
  fs: PrinterConfigurationFileSystem;
  isCurrentRenderer(sender: unknown): boolean;
}

/** Main-process handlers with the sender policy kept explicit and testable. */
export function createPrinterConfigurationIpcHandlers(
  deps: PrinterConfigurationIpcDependencies,
) {
  return {
    async load(sender: unknown) {
      if (!deps.isCurrentRenderer(sender)) return emptyPrinterConfigurationDocument();
      return loadPrinterConfigurationFile(deps.path(), deps.fs);
    },
    async save(sender: unknown, document: unknown): Promise<void> {
      if (!deps.isCurrentRenderer(sender)) throw new Error('printer configuration IPC sender rejected');
      await savePrinterConfigurationFile(deps.path(), document, deps.fs);
    },
  };
}
