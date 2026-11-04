import { useEffect, useRef, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import type { RemoteFile, RemoteFileRef } from '@orca/printer-control/domain';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { deleteStorageFile, pausesDeletion, type FileDeletionOutcome } from './deleteStorageFile';
type Item = { file: RemoteFile; result: FileDeletionOutcome | { state: 'pending' | 'not-sent' } };
export function DeleteStorageFiles({ files, printerName, storageName, onOutcome, onClose }: {
  files: readonly RemoteFile[]; printerName: string; storageName: string;
  onOutcome(file: RemoteFileRef, result: FileDeletionOutcome): void; onClose(): void;
}) {
  const service = usePlatform().printers.service;
  const [items, setItems] = useState<Item[]>(() => files.map(file => ({ file, result: { state: 'pending' } })));
  const [phase, setPhase] = useState<'confirm' | 'running' | 'paused' | 'done'>('confirm');
  const [stopRequested, setStopRequested] = useState(false);
  const position = useRef(0), running = useRef(false), stop = useRef(false), lifetime = useRef(new AbortController());
  const callback = useRef(onOutcome); callback.current = onOutcome;
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller; stop.current = false;
    return () => { stop.current = true; controller.abort(); };
  }, []);
  const leaveUnsent = () => setItems(previous => previous.map((item, index) => index >= position.current ? { ...item, result: { state: 'not-sent' } } : item));
  const run = async () => {
    const controller = lifetime.current;
    if (running.current || controller.signal.aborted) return;
    running.current = true; setPhase('running');
    try {
      while (position.current < files.length && !stop.current && !controller.signal.aborted) {
        const index = position.current++, file = files[index];
        const result = await deleteStorageFile(service, file.ref, controller.signal);
        if (controller.signal.aborted) return;
        setItems(previous => previous.map((item, i) => i === index ? { ...item, result } : item)); callback.current(file.ref, result);
        if (!stop.current && pausesDeletion(result) && position.current < files.length) { setPhase('paused'); return; }
      }
      if (!controller.signal.aborted) { leaveUnsent(); setPhase('done'); }
    } finally { running.current = false; }
  };
  const close = () => { if (!running.current) onClose(); };
  const counts = (state: string) => items.filter(item => item.result.state === state).length;
  return <Dialog open onOpenChange={open => { if (!open) close(); }} disablePointerDismissal={phase === 'running'}>
    <DialogContent className="max-w-lg">
      <DialogHeader><DialogTitle>{phase === 'confirm' ? 'Delete printer files?' : 'File deletion'}</DialogTitle>
        <DialogDescription>{printerName} · {storageName} · {files.length === 1 ? files[0].name : `${files.length} selected files`}</DialogDescription></DialogHeader>
      {phase === 'confirm' ? <p className="text-sm">These files will be permanently deleted from the printer. The printer decides whether files currently in use can be deleted.</p>
        : <p role="status" className="text-sm">{counts('deleted')} deleted · {counts('failed')} failed · {counts('unconfirmed')} unconfirmed · {counts('pending') + counts('not-sent')} not executed</p>}
      {phase === 'paused' && <p role="alert" className="text-sm">Deletion paused. The affected file will not be retried. Handle the problem before continuing with the remaining files, or stop the batch. Refresh storage manually to check unconfirmed files.</p>}
      <details open={phase !== 'confirm'}><summary className="cursor-pointer text-sm">Selected files</summary>
        <ul className="max-h-56 space-y-2 overflow-y-auto py-2 text-sm">{items.map(({ file, result }) => <li key={file.ref.fileId} className="break-all">
          {file.name}{phase !== 'confirm' && ` — ${result.state}`}
          {result.state === 'failed' && <p className="text-destructive">{result.error.message}</p>}
          {result.state === 'unconfirmed' && <p className="text-amber-500">{result.message}</p>}
        </li>)}</ul></details>
      <DialogFooter>
        {phase === 'confirm' && <><Button variant="outline" onClick={onClose}>Cancel</Button><Button variant="destructive" onClick={() => void run()}>Delete files</Button></>}
        {phase === 'running' && <Button variant="outline" disabled={stopRequested} onClick={() => { stop.current = true; setStopRequested(true); }}>Stop remaining deletions</Button>}
        {phase === 'paused' && <><Button variant="outline" onClick={() => { leaveUnsent(); setPhase('done'); }}>Stop batch</Button><Button onClick={() => void run()}>Continue remaining files</Button></>}
        {phase === 'done' && <Button onClick={onClose}>Close</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
