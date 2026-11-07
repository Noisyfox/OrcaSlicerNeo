/** One host repository owns configuration serialization and generations across providers. */
import { normalizePrinterConfigurationDocument, type PrinterConfiguration, type PrinterConfigurationDocument } from './configuration';
import type * as D from './domain';
import { fail } from './moonraker-http';
import { OperationStore, copy, newId } from './operations';

export interface HttpConfigurationRepository {
  onChanged?(listener: () => void): () => void;
  load(): Promise<PrinterConfigurationDocument>;
  save(document: PrinterConfigurationDocument): Promise<void>;
}
export interface ConfigurationEntry {
  readonly signature: string;
  readonly revision: D.Revision;
  readonly cache: Partial<{ [K in D.StateTopic]: D.Reading<D.PrinterObservationMap[K]> }>;
}
export interface ResolvedConfiguration {
  readonly printer: Readonly<PrinterConfiguration>;
  readonly entry: ConfigurationEntry;
}
export interface ConfigurationSnapshot {
  readonly document: PrinterConfigurationDocument;
  readonly printers: readonly ResolvedConfiguration[];
}
/** Shared by fresh service facades on the same host repository; never a caller session. */
const authorities = new WeakMap<object, { configurations: Map<string, ConfigurationEntry>; operations: Map<string, OperationStore>; additions: Map<string, { signature: string; printerId: string }>; configurationQueue: Promise<void>; listeners: Set<() => void> }>();

export function httpConfiguration(repository: HttpConfigurationRepository, driver: PrinterConfiguration['driverId']) {
  let authority = authorities.get(repository);
  if (!authority) {
    authority = { configurations: new Map(), operations: new Map(), additions: new Map(), configurationQueue: Promise.resolve(), listeners: new Set() };
    authorities.set(repository, authority);
  }
  const state = authority;
  /** Only local repository work is queued; printer I/O retains its resolved snapshot. */
  function withConfiguration<T>(work: () => T | Promise<T>): Promise<T> {
    const next = state.configurationQueue.then(work);
    state.configurationQueue = next.then(() => undefined, () => undefined);
    return next;
  }
  /** Called within the configuration queue, with a normalized, owned document. */
  function bindConfiguration(doc: PrinterConfigurationDocument): ConfigurationSnapshot {
    for (const id of state.configurations.keys()) if (!doc.printers.some(p => p.id === id)) state.configurations.delete(id);
    const printers = doc.printers.filter(printer => printer.driverId === driver).map(printer => {
      const signature = JSON.stringify([printer.driverId, printer.apiBaseUrl, printer.consoleUrl, printer.apiKey]);
      let entry = state.configurations.get(printer.id);
      if (entry?.signature !== signature) {
        entry = { signature, revision: newId<'configuration'>(), cache: {} };
        state.configurations.set(printer.id, entry);
      }
      // Retain this generation even if another request replaces the map entry.
      return { printer: Object.freeze(printer), entry };
    });
    return { document: doc, printers };
  }
  async function loadConfiguration(): Promise<ConfigurationSnapshot> {
    return bindConfiguration(normalizePrinterConfigurationDocument(await repository.load()));
  }
  async function saveConfiguration(doc: PrinterConfigurationDocument): Promise<ConfigurationSnapshot> {
    const normalized = normalizePrinterConfigurationDocument(doc);
    await repository.save(copy(normalized));
    const snapshot = bindConfiguration(normalized);
    for (const listener of state.listeners) {
      // A subscriber must not turn an already-persisted change into a failed mutation.
      try { listener(); } catch { /* Subscriber failures are isolated. */ }
    }
    return snapshot;
  }
  function resolveSnapshot(snapshot: ConfigurationSnapshot, target: D.TargetRequest): ResolvedConfiguration {
    const resolved = snapshot.printers.find(p => p.printer.id === target.printerId);
    if (!resolved || target.routeId !== `${driver}:${resolved.printer.id}`) fail('invalid-target', 'Printer route is no longer configured');
    if (target.expectedConfigurationRevision !== undefined && target.expectedConfigurationRevision !== resolved.entry.revision) fail('stale-context', 'Printer configuration changed');
    return resolved;
  }
  async function resolve(target: D.TargetRequest) {
    return resolveSnapshot(await withConfiguration(loadConfiguration), target);
  }
  return { state, withConfiguration, loadConfiguration, saveConfiguration, resolveSnapshot, resolve };
}
