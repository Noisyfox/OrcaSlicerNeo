import { useEffect, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import type { DownloadTaskSnapshot, PrinterDownloads, Result } from '@orca/printer-control/domain';
import { Button } from '@/components/ui/button';
export function usePrinterDownloadTasks(downloads: PrinterDownloads) {
  const [tasks, setTasks] = useState<readonly DownloadTaskSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (downloads.capability.kind !== 'supported') return;
    let alive = true, running = false, dirty = false;
    const read = async () => {
      if (running) { dirty = true; return; }
      running = true;
      do {
        dirty = false;
        try { const result = await downloads.list(); if (alive) { if (result.ok) { setTasks(result.value); setError(null); } else setError(result.error.message); } }
        catch { if (alive) setError('Download tasks could not be loaded.'); }
      } while (alive && dirty);
      running = false;
    };
    const stop = downloads.onChanged(() => { void read(); }); void read();
    return () => { alive = false; stop(); };
  }, [downloads]);
  return { tasks, error };
}
const size = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
export function PrinterDownloadTasks() {
  const downloads = usePlatform().printers.downloads, { tasks, error } = usePrinterDownloadTasks(downloads);
  const [actionError, setActionError] = useState<string | null>(null);
  const action = async (work: Promise<Result<unknown>>) => {
    try { const result = await work; setActionError(result.ok ? null : result.error.message); }
    catch { setActionError('The download action could not be completed.'); }
  };
  if (downloads.capability.kind !== 'supported') return null;
  return <details className="shrink-0 rounded border p-2 text-sm" open={tasks.some(task => ['waiting', 'running', 'paused'].includes(task.state))}>
    <summary className="cursor-pointer">Downloads ({tasks.length})</summary>
    {(error || actionError) && <p role="alert" className="text-destructive">{actionError ?? error}</p>}
    <div className="max-h-48 overflow-y-auto" aria-label="Download tasks">
      {[...tasks].reverse().map(task => <div key={task.id} className="flex flex-wrap items-center gap-2 border-t py-2" data-testid="download-task">
        <div className="min-w-0 flex-1"><p className="truncate" title={task.name}>{task.name} · {task.printerName}</p>
          <p className="text-xs text-muted-foreground">{task.state === 'running' && !task.canCancel ? 'Finishing' : task.state} · {size(task.writtenBytes)}{task.totalBytes !== null && ` / ${size(task.totalBytes)}`}</p>
          {task.error && <p className="text-xs text-destructive">{task.error.message}</p>}
          {task.warning && <p className="text-xs text-amber-500">{task.warning}</p>}
        </div>
        {task.state === 'running' && <progress aria-label={`Download ${task.name}`} max={task.totalBytes ?? undefined} value={task.totalBytes ? task.writtenBytes : undefined} className="w-20" />}
        {task.canCancel && <Button size="sm" variant="ghost" onClick={() => void action(downloads.cancel(task.id))}>Cancel</Button>}
        {task.canRetry && <Button size="sm" variant="outline" onClick={() => void action(downloads.retry(task.id))}>Retry from start</Button>}
        {task.state === 'paused' && <Button size="sm" variant="ghost" onClick={() => void action(downloads.continue(task.id))}>Skip and continue</Button>}
        {task.state === 'saved' && <Button size="sm" variant="outline" onClick={() => void action(downloads.open(task.id))}>Open file</Button>}
      </div>)}
      {!tasks.length && <p className="py-2 text-muted-foreground">No downloads in this session.</p>}
    </div>
  </details>;
}
