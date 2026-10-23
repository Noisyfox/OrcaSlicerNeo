import { useEffect, useRef, useState } from 'react';
import type * as D from '@orca/printer-control/domain';
const topics = ['descriptor', 'status', 'thermal', 'motion', 'actuators', 'materials', 'sensors', 'alerts', 'firmware'] as const;
/** Keep the selected provider subscription alive when the page is hidden; publish only visible UI state. */
export function useLivePrinter(service: D.PrinterService, printer: D.SavedPrinter, route: D.PrinterRoute, visible: boolean) {
  const [started, setStarted] = useState(visible);
  const [snapshot, setSnapshot] = useState<D.PrinterSnapshot | null>(null);
  const [capabilities, setCapabilities] = useState(route.capabilities);
  const [error, setError] = useState<string | null>(null);
  const latestError = useRef<string | null>(null);
  const latest = useRef<D.PrinterSnapshot | null>(null), visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => { if (visible) { setStarted(true); setSnapshot(latest.current); setError(latestError.current); } }, [visible]);
  useEffect(() => {
    if (!started) return;
    const abort = new AbortController();
    const target = { printerId: printer.identity.id, routeId: route.id };
    void (async () => {
      for await (const event of service.observations.watch({ target, topics }, { signal: abort.signal })) {
        if (abort.signal.aborted) return;
        if (event.type === 'snapshot') latest.current = event.snapshot;
        else if (latest.current) latest.current = { ...latest.current, configurationRevision: event.configurationRevision, values: { ...latest.current.values, ...event.values } };
        latestError.current = null;
        if (visibleRef.current) { setSnapshot(latest.current); setError(null); }
        const description = await service.describe(target, { signal: abort.signal });
        if (!abort.signal.aborted && visibleRef.current && description.ok) setCapabilities(description.value.capabilities);
      }
    })().catch(() => { if (!abort.signal.aborted) { latestError.current = 'Printer monitoring is unavailable.'; if (visibleRef.current) setError(latestError.current); } });
    return () => abort.abort();
  }, [service, printer.identity.id, route.id, route.configurationRevision, started]);
  useEffect(() => {
    if (!visible || !started) return;
    const abort = new AbortController();
    void service.describe({ printerId: printer.identity.id, routeId: route.id }, { signal: abort.signal }).then(result => { if (!abort.signal.aborted && result.ok) setCapabilities(result.value.capabilities); }).catch(() => {});
    return () => abort.abort();
  }, [visible, started, service, printer.identity.id, route.id]);
  return { snapshot, capabilities, error };
}
