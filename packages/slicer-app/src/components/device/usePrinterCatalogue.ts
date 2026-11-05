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
  printers: readonly SavedPrinter[], projectPrinter: string, enabled: boolean,
) {
  const [result, setResult] = useState<{
    source: readonly SavedPrinter[]; projectPrinter: string; matches: ReadonlySet<string>; failed: boolean;
  } | null>(null);
  const identities = useMemo(() => new Map(printers.flatMap(printer => {
    const configured = printer.configuredModel;
    const identity = configured
      ? { manufacturer: configured.vendorId || null, model: configured.model, externalRefs: [] }
      : printer.identity;
    return identity.model?.trim() || identity.externalRefs.some(ref => ref.namespace === 'orca-printer-model' && ref.value)
      ? [[printer.identity.id, { manufacturer: identity.manufacturer, model: identity.model, externalRefs: identity.externalRefs }] as const] : [];
  })), [printers]);
  useEffect(() => {
    if (!enabled || !identities.size) return;
    let active = true;
    void Promise.all([...identities].map(async ([id, identity]) => {
      try {
        const match = await runtime.getPrinterDeviceMatch(identity);
        return { id, matches: match.ok && match.matches, failed: !match.ok };
      } catch { return { id, matches: false, failed: true }; }
    })).then(matches => {
      if (active) setResult({ source: printers, projectPrinter,
        matches: new Set(matches.filter(match => match.matches).map(match => match.id)), failed: matches.some(match => match.failed) });
    });
    return () => { active = false; };
  }, [runtime, printers, identities, projectPrinter, enabled]);
  const current = result?.source === printers && result.projectPrinter === projectPrinter ? result : null;
  const filtered = useMemo(() => identities.size
    ? printers.filter(printer => !identities.has(printer.identity.id) || current?.matches.has(printer.identity.id)) : printers,
  [printers, identities, current]);
  return { printers: filtered, pending: enabled && identities.size > 0 && current === null, failed: current?.failed ?? false };
}
