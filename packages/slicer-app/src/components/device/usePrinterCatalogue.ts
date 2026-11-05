import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PrinterService, SavedPrinter } from '@orca/printer-control/domain';
import type { PlatformCapabilities } from '@orca/platform-contract';

/** Local provider projection only. Invalidations never start discovery or device probes. */
export function usePrinterCatalogue(service: PrinterService, enabled = true) {
  const [printers, setPrinters] = useState<readonly SavedPrinter[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
    setPrinters([]);
    if (!enabled) return;
    let active = true;
    let generation = 0;
    const reload = async () => {
      const request = ++generation;
      try {
        const result = await service.listSaved();
        if (!active || request !== generation) return;
        if (result.ok) setPrinters(result.value);
        setFailed(!result.ok);
      } catch {
        if (!active || request !== generation) return;
        setFailed(true);
      }
      if (active && request === generation) setLoaded(true);
    };
    refreshRef.current = reload;
    const stop = service.onSavedChanged(() => { void reload(); });
    void reload();
    return () => { active = false; stop(); refreshRef.current = async () => {}; };
  }, [service, enabled]);
  return { printers, loaded, failed, refresh };
}

/** Resolve manual associations or provider identities through the existing native model matcher. */
export function usePrinterModelFilter(
  runtime: Pick<PlatformCapabilities['runtime'], 'getPrinterDeviceMatch'>,
  printers: readonly SavedPrinter[], enabled: boolean,
) {
  type Match = { key: string; matches: boolean | null; failed: boolean };
  type PrinterId = SavedPrinter['identity']['id'];
  const cache = useRef(new Map<PrinterId, Match>());
  const [results, setResults] = useState<ReadonlyMap<PrinterId, Match>>(new Map());
  const identities = useMemo(() => new Map(printers.flatMap(printer => {
    const configured = printer.configuredModel;
    const reported = printer.identity;
    // Only exact catalogue references participate in this native query. Their
    // order, unrelated provider metadata and route updates do not change a match.
    const externalRefs = [...new Set(reported.externalRefs.filter(ref => ref.namespace === 'orca-printer-model' && ref.value)
      .map(ref => ref.value))].sort().map(value => ({ namespace: 'orca-printer-model', value }));
    const identity = configured
      ? { manufacturer: configured.vendorId || null, model: configured.model, externalRefs: [] }
      : { manufacturer: reported.manufacturer, model: reported.model, externalRefs };
    return identity.model?.trim() || identity.externalRefs.length
      ? [[reported.id, { identity, key: JSON.stringify(identity) }] as const] : [];
  })), [printers]);

  // The project is fixed while this modal is open. Matches belong to this open
  // session, and late replies cannot populate a closed or reopened session.
  useEffect(() => () => { cache.current.clear(); }, [runtime, enabled]);
  useEffect(() => {
    if (!enabled) { setResults(new Map()); return; }
    let changed = false;
    for (const id of cache.current.keys()) {
      if (!identities.has(id)) { cache.current.delete(id); changed = true; }
    }
    for (const [id, { identity, key }] of identities) {
      const cached = cache.current.get(id);
      if (cached?.key === key && !cached.failed) continue;
      const entry: Match = { key, matches: null, failed: false };
      cache.current.set(id, entry); changed = true;
      void (async () => {
        let result: Match;
        try {
          const match = await runtime.getPrinterDeviceMatch(identity);
          result = { key, matches: match.ok && match.matches, failed: !match.ok };
        } catch { result = { key, matches: false, failed: true }; }
        if (cache.current.get(id) !== entry) return;
        cache.current.set(id, result);
        setResults(new Map(cache.current));
      })();
    }
    if (changed) setResults(new Map(cache.current));
  }, [runtime, identities, enabled]);

  return useMemo(() => {
    const pending = new Set<string>();
    let failed = false;
    const filtered = printers.filter(printer => {
      const input = identities.get(printer.identity.id);
      if (!input) return true;
      const result = results.get(printer.identity.id);
      if (result?.key !== input.key || result.matches === null) {
        if (enabled) pending.add(printer.identity.id);
        return false;
      }
      failed ||= result.failed;
      return result.matches;
    });
    return { printers: filtered, pending, failed };
  }, [printers, identities, results, enabled]);
}
