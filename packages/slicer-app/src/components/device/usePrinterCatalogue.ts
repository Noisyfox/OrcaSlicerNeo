import { useCallback, useEffect, useRef, useState } from 'react';
import type { PrinterService, SavedPrinter } from '@orca/printer-control/domain';

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
