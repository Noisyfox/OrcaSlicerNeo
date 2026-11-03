import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePlatform } from '@orca/platform-contract';
import type { MediaDescriptor, RemoteFile } from '@orca/printer-control/domain';
const waiting: (() => void)[] = []; let active = 0;
async function admitted<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T | undefined> {
  let acquired = false;
  await new Promise<void>(resolve => {
    const enter = () => { acquired = true; active++; signal.removeEventListener('abort', abort); resolve(); };
    const abort = () => { const index = waiting.indexOf(enter); if (index >= 0) { waiting.splice(index, 1); resolve(); } };
    if (signal.aborted) { resolve(); return; }
    if (active < 2) enter(); else { waiting.push(enter); signal.addEventListener('abort', abort, { once: true }); }
  });
  if (!acquired) return;
  try { if (!signal.aborted) return await work(); }
  finally { active--; waiting.shift()?.(); }
}
/** A viewport read owns its preview lease; scrolling away or switching scope releases it. */
export function StorageThumbnail({ file, fallback }: { file: RemoteFile; fallback: ReactNode }) {
  const service = usePlatform().printers.service, element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false), [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: '80px' });
    if (element.current) observer.observe(element.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setUrl(null); if (!visible) return;
    const controller = new AbortController(); let descriptor: MediaDescriptor | undefined, renewal: ReturnType<typeof setTimeout> | undefined;
    const renew = () => {
      if (!descriptor?.expiresAtMs || controller.signal.aborted) return;
      renewal = setTimeout(() => { if (!descriptor || controller.signal.aborted) return;
        void service.media.renew(descriptor.ref, { signal: controller.signal }).then(result => {
          if (!controller.signal.aborted && result.ok) { descriptor = result.value; renew(); }
        }).catch(() => {});
      }, Math.max(1000, (descriptor.expiresAtMs - Date.now()) / 2));
    };
    void admitted(controller.signal, async () => {
      const previews = await service.files.listPreviews(file.ref, { signal: controller.signal });
      if (!previews.ok || controller.signal.aborted) return;
      const option = previews.value.options.find(option => option.kind === 'thumbnail'); if (!option) return;
      const result = await service.media.open({ target: { printerId: file.ref.printerId, routeId: file.ref.routeId, expectedConfigurationRevision: file.ref.configurationRevision },
        requestId: crypto.randomUUID() as never, source: { kind: 'file-preview', target: file.ref, previewId: option.id },
        client: { imageMimeTypes: ['image/png', 'image/jpeg'], video: [], contentFormats: [] } }, { signal: controller.signal });
      if (!result.ok) return; descriptor = result.value;
      if (controller.signal.aborted || result.value.presentation.kind !== 'image') { await service.media.close(descriptor.ref); descriptor = undefined; return; }
      setUrl(result.value.presentation.url); renew();
    }).catch(() => { /* Optional images never hide a file or trigger automatic retries. */ });
    return () => { controller.abort(); if (renewal) clearTimeout(renewal); if (descriptor) void service.media.close(descriptor.ref).catch(() => {}); };
  }, [visible, service, file]);
  return <div ref={element} className="flex h-20 w-full items-center justify-center overflow-hidden rounded bg-muted/20">
    {url ? <img src={url} alt={`Thumbnail of ${file.name}`} className="size-full object-contain" onError={() => setUrl(null)} /> : fallback}
  </div>;
}
