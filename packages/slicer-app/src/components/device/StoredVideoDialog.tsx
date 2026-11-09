import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import type * as D from '@orca/printer-control/domain';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cameraClientCapabilities } from './media/playback';
import { StoredVideoPlayer } from './media/StoredVideoPlayer';

export function StoredVideoDialog({ file, printerName, canDownload, onClose }: { file: D.RemoteFile; printerName: string; canDownload: boolean; onClose(): void }) {
  const { service, downloads } = usePlatform().printers;
  const [descriptor, setDescriptor] = useState<D.MediaDescriptor | null>(null), [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false), [queued, setQueued] = useState(false);
  const [closing, setClosing] = useState(false), [cleanupFailed, setCleanupFailed] = useState(false);
  const release = useRef<() => Promise<void>>(async () => {});
  const failed = useCallback((message: string) => {
    setError(message); setDescriptor(null);
    void release.current().catch(() => setError(`${message} Temporary video cleanup failed.`));
  }, []);
  useEffect(() => {
    const abort = new AbortController(); let owned: D.MediaRef | undefined, renewal: ReturnType<typeof setTimeout> | undefined;
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      abort.abort(); clearTimeout(renewal);
      if (owned) { const result = await service.media.close(owned); if (!result.ok) throw new Error('Video cleanup failed.'); }
    })();
    release.current = close;
    const renew = (value: D.MediaDescriptor) => {
      clearTimeout(renewal); if (value.expiresAtMs === null || abort.signal.aborted) return;
      renewal = setTimeout(() => { void service.media.renew(value.ref, { signal: abort.signal }).then(result => {
        if (abort.signal.aborted) return;
        if (!result.ok) { failed(result.error.message); return; }
        setDescriptor(result.value); renew(result.value);
      }).catch(() => { if (!abort.signal.aborted) failed('Video access could not be renewed.'); }); }, Math.max(1000, (value.expiresAtMs - Date.now()) / 2));
    };
    void (async () => {
      const previews = await service.files.listPreviews(file.ref, { signal: abort.signal }); if (abort.signal.aborted) return;
      if (!previews.ok) { failed(previews.error.message); return; }
      const preview = previews.value.options.find(option => option.kind === 'video');
      if (!preview) { failed('This file has no video preview.'); return; }
      const client = cameraClientCapabilities();
      const result = await service.media.open({ requestId: crypto.randomUUID() as D.Id<'request'>,
        target: { printerId: file.ref.printerId, routeId: file.ref.routeId, expectedConfigurationRevision: file.ref.configurationRevision },
        source: { kind: 'file-preview', target: file.ref, previewId: preview.id },
        client: { ...client, video: client.video.filter(v => v.transport === 'mse-fmp4' || v.transport === 'progressive-http') } }, { signal: abort.signal });
      if (!result.ok) { if (!abort.signal.aborted) failed(result.error.message); return; }
      owned = result.value.ref;
      if (abort.signal.aborted) { await service.media.close(owned); return; }
      if (result.value.presentation.kind !== 'video' || result.value.presentation.live) { failed('This file has no stored video presentation.'); return; }
      setDescriptor(result.value); renew(result.value);
      if (result.value.presentation.delivery.transport === 'progressive-http') return;
      for await (const event of service.media.watch(owned, { signal: abort.signal })) {
        if (abort.signal.aborted) return;
        if (event.payload.type === 'descriptor') setDescriptor(event.payload.descriptor);
        if (event.payload.type === 'error') { failed(event.payload.error.message); return; }
        if (event.payload.type === 'closed') { failed('The video was closed.'); return; }
      }
    })().catch(() => { if (!abort.signal.aborted) failed('Stored video could not be played.'); });
    return () => { void close().catch(() => {}); };
  }, [service, file, failed]);
  const save = async () => {
    setSaving(true);
    try {
      await release.current(); setDescriptor(null);
      const result = await downloads.start({ files: [{ file: file.ref, name: file.name, printerName }], destination: 'default' });
      if (!result.ok) setError(result.error.message); else if (result.value.status === 'queued') setQueued(true);
    } catch { setError('The video could not be queued for download.'); }
    finally { setSaving(false); }
  };
  const close = async () => {
    if (closing) return;
    if (cleanupFailed) { onClose(); return; }
    setClosing(true); setDescriptor(null);
    try { await release.current(); onClose(); }
    catch { setCleanupFailed(true); setError('Temporary video cleanup failed. You can close this viewer; the next launch will try to remove abandoned cache.'); }
    finally { setClosing(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open) void close(); }}>
    <DialogContent className="sm:max-w-4xl"><DialogHeader><DialogTitle>Stored video</DialogTitle><DialogDescription>{file.name}</DialogDescription></DialogHeader>
      {descriptor && !error && <StoredVideoPlayer descriptor={descriptor} media={service.media} onError={failed} />}
      {!descriptor && !error && !queued && <p role="status">{canDownload ? 'Waiting for a transfer slot and reading video…' : 'Opening video…'}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {queued && <p role="status">Download queued. When it finishes, choose Open in Storage downloads to use your system player.</p>}
      <div className="flex justify-end gap-2">{canDownload && <Button variant="outline" disabled={saving || closing || queued || downloads.capability.kind !== 'supported'} onClick={() => void save()}>Download for system player</Button>}
        <Button variant="ghost" disabled={closing} onClick={() => void close()}>{cleanupFailed ? 'Close anyway' : 'Close'}</Button></div>
    </DialogContent>
  </Dialog>;
}
