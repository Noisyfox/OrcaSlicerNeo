import { useCallback, useRef, useState } from 'react';
import type { PrinterService } from '@orca/printer-control/domain';
import { sendActivity } from '@orca/printer-control';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useProjectModal } from '../useProjectModal';
/** The desktop close handshake reaches this after the project-save decision. */
export function useSendExitGuard(service: PrinterService) {
  const [open, setOpen] = useState(false), [stopping, setStopping] = useState(false);
  useProjectModal(open, '[data-testid="send-exit-dialog"]');
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
  const dialog = open ? <Dialog open disablePointerDismissal onOpenChange={nextOpen => { if (!nextOpen && !stopping) finish(false); }}>
    <DialogContent role="alertdialog" data-testid="send-exit-dialog">
      <DialogHeader>
        <DialogTitle>Sending is still in progress</DialogTitle>
        <DialogDescription>Return to wait, or stop unfinished local sending and exit. Commands already sent may take effect. This does not stop a print on the printer.</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="secondary" disabled={stopping} onClick={() => finish(false)}>Return to app</Button>
        <Button variant="destructive" disabled={stopping} onClick={() => void stop()}>{stopping ? 'Stopping sends…' : 'Stop sending and exit'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog> : null;
  return { confirm, dialog };
}
