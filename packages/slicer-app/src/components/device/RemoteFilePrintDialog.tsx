import { useCallback, useEffect, useState } from 'react';
import { Box } from 'lucide-react';
import { usePlatform } from '@orca/platform-contract';
import type * as D from '@orca/printer-control/domain';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PrintPreparationView } from '../send/PrintPreparationPanel';
import { useRemotePrintPreparation } from '../send/useRemotePrintPreparation';
import { StorageThumbnail } from './StorageThumbnail';
import { useDeviceSelectionStore } from '@/stores/useDeviceSelectionStore';

export function RemoteFilePrintDialog({ file, printer, onClose }: { file: D.RemoteFile; printer: D.SavedPrinter; onClose(): void }) {
  const service = usePlatform().printers.service;
  const [inspection, setInspection] = useState<D.RemotePrintInspection | null>(null), [targetId, setTargetId] = useState('');
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); let owned: D.RemotePrintInspectionRef | undefined;
    setInspection(null); setError(null);
    void service.remotePrints.inspect(file.ref, { signal: abort.signal }).then(result => {
      if (abort.signal.aborted) { if (result.ok) void service.remotePrints.release(result.value.ref).catch(() => {}); return; }
      if (!result.ok) { setError(result.error.message); return; }
      owned = result.value.ref; setInspection(result.value);
      setTargetId(result.value.targets.find(t => t.availability.kind === 'available')?.id ?? result.value.targets[0]?.id ?? '');
      if (!result.value.targets.length) setError('This file contains no available print targets.');
    }).catch(() => { if (!abort.signal.aborted) setError('The device file could not be inspected.'); });
    return () => { abort.abort(); if (owned) void service.remotePrints.release(owned).catch(() => {}); };
  }, [service, file, attempt]);
  const selected = inspection?.targets.find(t => t.id === targetId);
  const close = () => { if (!busy) onClose(); };
  return <Dialog open onOpenChange={open => { if (!open) close(); }} disablePointerDismissal={busy}>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
      <DialogHeader><DialogTitle>Print device file</DialogTitle><DialogDescription>{file.name} · {printer.identity.displayName}</DialogDescription></DialogHeader>
      {!inspection && !error && <p role="status">Reading device file metadata…</p>}
      {error && <div className="space-y-3"><p role="alert" className="text-sm text-destructive">{error}</p><Button variant="outline" onClick={() => setAttempt(v => v + 1)}>Retry inspection</Button></div>}
      {inspection && inspection.targets.length > 1 && <label className="flex items-center gap-3 text-sm">Print target
        <select aria-label="Print target" className="rounded border bg-background p-2" disabled={busy} value={targetId} onChange={event => setTargetId(event.target.value)}>
          {inspection.targets.map(target => <option key={target.id} value={target.id}>{target.label}</option>)}
        </select>
      </label>}
      {inspection && selected?.availability.kind === 'available' && selected.requirements
        ? <PreparedTarget key={selected.id} inspection={inspection} selected={selected} file={file} printer={printer} onClose={onClose} onBusyChange={setBusy} />
        : <>{selected?.availability.kind === 'blocked' && selected.availability.reasons.map((reason, i) => <p role="alert" key={i}>{reason.message}</p>)}
          {selected?.availability.kind === 'unknown' && <p role="status">{selected.availability.reason}</p>}
          <Button variant="ghost" onClick={close}>Close</Button></>}
    </DialogContent>
  </Dialog>;
}

function PreparedTarget({ inspection, selected, file, printer, onClose, onBusyChange }: {
  inspection: D.RemotePrintInspection; selected: D.RemotePrintTarget; file: D.RemoteFile; printer: D.SavedPrinter; onClose(): void; onBusyChange(value: boolean): void;
}) {
  const platform = usePlatform();
  const sent = useCallback(() => { useDeviceSelectionStore.getState().showPrinter(printer.identity.id); onClose(); }, [printer.identity.id, onClose]);
  const state = useRemotePrintPreparation(platform, printer, inspection, selected, file.name, sent);
  return <PrintPreparationView state={state} printer={printer} onClose={onClose} onBusyChange={onBusyChange} nameReadOnly
    thumbnail={<StorageThumbnail file={file} preview={selected.thumbnail ?? null} className="h-40" fallback={<Box className="size-24 text-muted-foreground/40" aria-label="Model preview unavailable" />} />} />;
}
