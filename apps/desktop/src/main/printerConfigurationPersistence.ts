import {
  normalizePrinterConfigurationDocument,
  type PrinterConfigurationDocument,
} from '../../../../packages/printer-control/src/configuration';

export interface PrinterConfigurationFileSystem {
  readText?(path: string): Promise<string>;
  writeText?(path: string, value: string): Promise<void>;
}

export function emptyPrinterConfigurationDocument(): PrinterConfigurationDocument {
  return { version: 1, printers: [] };
}

/** Load is deliberately fail-closed: a bad file starts with no printers. */
export async function loadPrinterConfigurationFile(
  path: string,
  fs: PrinterConfigurationFileSystem,
): Promise<PrinterConfigurationDocument> {
  try {
    if (!fs.readText) return emptyPrinterConfigurationDocument();
    const parsed: unknown = JSON.parse(await fs.readText(path));
    return normalizePrinterConfigurationDocument(parsed);
  } catch {
    return emptyPrinterConfigurationDocument();
  }
}

/** Validate before serialization so the file always contains a full document. */
export async function savePrinterConfigurationFile(
  path: string,
  document: unknown,
  fs: PrinterConfigurationFileSystem,
): Promise<void> {
  const normalized = normalizePrinterConfigurationDocument(document);
  if (!fs.writeText) throw new Error('printer configuration storage is unavailable');
  await fs.writeText(path, JSON.stringify(normalized, null, 2));
}
