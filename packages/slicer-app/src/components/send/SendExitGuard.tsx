import { useCallback, useRef, useState } from 'react';
import type { PrinterService } from '@orca/printer-control/domain';
import { sendActivity } from '@orca/printer-control';
import { Button } from '@/components/ui/button';
/** The desktop close handshake reaches this after the project-save decision. */
export function useSendExitGuard(service: PrinterService) {
  const [open, setOpen] = useState(false), [stopping, setStopping] = useState(false);
  const pending = useRef<{ promise: Promise<boolean>; resolve(value: boolean): void } | null>(null);
  const confirm = useCallback((): Promise<boolean> => {
    if (pending.current) return pending.current.promise;
    if (!sendActivity(service).active) return Promise.resolve(true);
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>(done => { resolve = done; });
    pending.current = { promise, resolve }; setOpen(true); return promise;
  }, [service]);
  function finish(allow: boolean) { pending.current?.resolve(allow); pending.current = null; setOpen(false); setStopping(false); }
  async function stop() { setStopping(true); await sendActivity(service).stop(); finish(true); }
  const dialog = open ? <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="alertdialog" aria-modal="true" aria-labelledby="send-exit-title"><div className="w-full max-w-md space-y-4 rounded-lg border bg-card p-5 shadow-lg">
    <h2 id="send-exit-title" className="font-semibold">Sending is still in progress</h2><p className="text-sm">Return to wait, or stop unfinished local sending and exit. Commands already sent may take effect. This does not stop a print on the printer.</p>
    <div className="flex justify-end gap-2"><Button variant="secondary" disabled={stopping} onClick={() => finish(false)}>Return to app</Button><Button variant="destructive" disabled={stopping} onClick={() => void stop()}>{stopping ? 'Stopping sends…' : 'Stop sending and exit'}</Button></div>
  </div></div> : null;
  return { confirm, dialog };
}
