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

/** Optional user association only; provider identities and sync policy stay with their existing owners. */
export function usePrinterModelFilter(
  runtime: Pick<PlatformCapabilities['runtime'], 'getPrinterDeviceMatch'>,
  printers: readonly SavedPrinter[], projectPrinter: string, enabled: boolean,
) {
  const [result, setResult] = useState<{
    source: readonly SavedPrinter[]; projectPrinter: string; matches: ReadonlySet<string>; failed: boolean;
  } | null>(null);
  const configured = useMemo(() => printers.filter(printer => printer.configuredModel), [printers]);
  useEffect(() => {
    if (!enabled || !configured.length) return;
    let active = true;
    void Promise.all(configured.map(async printer => {
      const { vendorId, model } = printer.configuredModel!;
      try {
        const match = await runtime.getPrinterDeviceMatch({ manufacturer: vendorId || null, model, externalRefs: [] });
        return { id: printer.identity.id, matches: match.ok && match.matches, failed: !match.ok };
      } catch { return { id: printer.identity.id, matches: false, failed: true }; }
    })).then(matches => {
      if (active) setResult({ source: printers, projectPrinter,
        matches: new Set(matches.filter(match => match.matches).map(match => match.id)), failed: matches.some(match => match.failed) });
    });
    return () => { active = false; };
  }, [runtime, printers, configured, projectPrinter, enabled]);
  const current = result?.source === printers && result.projectPrinter === projectPrinter ? result : null;
  const filtered = useMemo(() => configured.length
    ? printers.filter(printer => !printer.configuredModel || current?.matches.has(printer.identity.id)) : printers,
  [printers, configured, current]);
  return { printers: filtered, pending: enabled && configured.length > 0 && current === null, failed: current?.failed ?? false };
}
