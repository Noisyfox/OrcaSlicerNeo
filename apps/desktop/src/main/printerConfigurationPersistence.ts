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

/** Apply only the records this instance edited; refuse conflicting edits/deletions. */
export function mergePrinterConfigurations(base: PrinterConfigurationDocument, next: PrinterConfigurationDocument, current: PrinterConfigurationDocument): PrinterConfigurationDocument {
  const before = new Map(base.printers.map(printer => [printer.id, printer]));
  const after = new Map(next.printers.map(printer => [printer.id, printer]));
  const merged = new Map(current.printers.map(printer => [printer.id, printer]));
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (JSON.stringify(before.get(id)) === JSON.stringify(after.get(id))) continue;
    if (JSON.stringify(merged.get(id)) !== JSON.stringify(before.get(id)) && JSON.stringify(merged.get(id)) !== JSON.stringify(after.get(id))) {
      throw new Error('This printer was changed in another application instance. Reload the device list before saving.');
    }
    const value = after.get(id);
    if (value) merged.set(id, value); else merged.delete(id);
  }
  return { version: 1, printers: [...merged.values()] };
}
