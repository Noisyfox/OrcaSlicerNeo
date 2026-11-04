import { useEffect, useRef, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { usePrinterDownloadTasks } from './PrinterDownloadTasks';
import { Button } from '@/components/ui/button';
/** Completion/failure notices only; task management remains inside Storage. */
export function PrinterDownloadNotifications() {
  const { tasks } = usePrinterDownloadTasks(usePlatform().printers.downloads);
  const seen = useRef(new Map<string, string>());
  const [notices, setNotices] = useState<{ id: string; text: string }[]>([]);
  useEffect(() => {
    const additions: { id: string; text: string }[] = [];
    for (const task of tasks) {
      const state = `${task.attempt}:${task.state}`;
      if (seen.current.get(task.id) === state) continue;
      seen.current.set(task.id, state);
      if (['saved', 'failed', 'paused'].includes(task.state)) additions.push({ id: `${task.id}:${state}`,
        text: `${task.name}: ${task.state === 'saved' ? 'Download saved.' : task.error?.message ?? 'Download failed.'}${task.warning ? ` ${task.warning}` : ''}` });
    }
    if (additions.length) setNotices(previous => [...previous, ...additions].slice(-5));
    const ids = new Set<string>(tasks.map(task => task.id)); for (const id of seen.current.keys()) if (!ids.has(id)) seen.current.delete(id);
  }, [tasks]);
  if (!notices.length) return null;
  return <div className="fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2" aria-live="polite">
    {notices.map(notice => <div key={notice.id} className="flex items-center gap-2 rounded-lg border bg-background p-3 text-sm shadow-lg">
      <p className="break-all">{notice.text}</p><Button size="sm" variant="ghost" aria-label="Dismiss download notification" onClick={() => setNotices(previous => previous.filter(item => item.id !== notice.id))}>×</Button>
    </div>)}
  </div>;
}
