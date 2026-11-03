import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePlatform } from '@orca/platform-contract';
import type { MediaDescriptor, RemoteFile, FilePreviewOption } from '@orca/printer-control/domain';
import { snapshotThumbnail, useThumbnailCache } from './media/ThumbnailCache';
const waiting: (() => void)[] = []; let active = 0;
async function admitted<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T | undefined> {
  let acquired = false;
  await new Promise<void>(resolve => {
    const enter = () => { acquired = true; active++; signal.removeEventListener('abort', abort); resolve(); };
    const abort = () => { const index = waiting.indexOf(enter); if (index >= 0) { waiting.splice(index, 1); resolve(); } };
    if (signal.aborted) { resolve(); return; }
    if (active < 8) enter(); else { waiting.push(enter); signal.addEventListener('abort', abort, { once: true }); }
  });
  if (!acquired) return;
  try { if (!signal.aborted) return await work(); }
  finally { active--; waiting.shift()?.(); }
}
/** Viewport reads populate the shared browser cache; provider leases end after copying. */
export function StorageThumbnail({ file, fallback, preview, className }: { file: RemoteFile; fallback: ReactNode; preview?: FilePreviewOption | null; className?: string }) {
  const service = usePlatform().printers.service, element = useRef<HTMLDivElement>(null);
  const cache = useThumbnailCache();
  const key = JSON.stringify([file.ref.printerId, file.ref.routeId, file.ref.configurationRevision, file.ref.storageId, file.ref.fileId, preview?.id ?? null]);
  const [visible, setVisible] = useState(false), [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: '80px' });
    if (element.current) observer.observe(element.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setUrl(null); if (!visible || preview === null) return;
    let cancelled = false;
    const cached = cache.acquire(key, signal => admitted(signal, async () => {
      let option = preview;
      if (!option) {
        const previews = await service.files.listPreviews(file.ref, { signal });
        if (!previews.ok) throw new Error(previews.error.message);
        option = previews.value.options.find(option => option.kind === 'thumbnail');
      }
      if (!option || signal.aborted) return null;
      let descriptor: MediaDescriptor | undefined, renewal: ReturnType<typeof setTimeout> | undefined;
      const renew = () => {
        if (!descriptor?.expiresAtMs || signal.aborted) return;
        renewal = setTimeout(() => { if (!descriptor || signal.aborted) return;
          void service.media.renew(descriptor.ref, { signal }).then(result => {
            if (!signal.aborted && result.ok) { descriptor = result.value; renew(); }
          }).catch(() => {});
        }, Math.max(1000, (descriptor.expiresAtMs - Date.now()) / 2));
      };
      try {
        const result = await service.media.open({ target: { printerId: file.ref.printerId, routeId: file.ref.routeId, expectedConfigurationRevision: file.ref.configurationRevision },
          requestId: crypto.randomUUID() as never, source: { kind: 'file-preview', target: file.ref, previewId: option.id },
          client: { imageMimeTypes: ['image/png', 'image/jpeg'], video: [], contentFormats: [] } }, { signal });
        if (!result.ok) {
          if (result.error.code === 'preview-unavailable') return null;
          throw new Error(result.error.message);
        }
        descriptor = result.value;
        if (signal.aborted || descriptor.presentation.kind !== 'image') return null;
        renew(); return await snapshotThumbnail(descriptor.presentation.url, signal);
      } finally {
        if (renewal) clearTimeout(renewal);
        if (descriptor) await service.media.close(descriptor.ref).catch(() => {});
      }
    }).then(result => result ?? null));
    void cached.result.then(image => { if (!cancelled) setUrl(image); }).catch(() => {
      // Optional images never hide a file or trigger automatic retries.
    });
    return () => { cancelled = true; cached.release(); };
  }, [visible, service, cache, key, preview === null]);
  return <div ref={element} className={`flex w-full items-center justify-center overflow-hidden rounded bg-muted/20 ${className ?? 'h-20'}`}>
    {url ? <img src={url} alt={`Thumbnail of ${file.name}`} className="size-full object-contain" onError={() => setUrl(null)} /> : fallback}
  </div>;
}
