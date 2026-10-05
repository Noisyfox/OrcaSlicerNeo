import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlateSessionSnapshot } from '@slicer/client';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import { useObjectListStore } from './objectList/useObjectListStore';
import { glVolumeCollection } from './viewport/GLVolume';
import { projectPlateThumbnail } from './plateThumbnailScene';
import type { PlateThumbnailService } from './plateThumbnailService';

// Image resolution is independent of sidebar width, display size, and DPR.
const THUMBNAIL_RENDER_SIZE = 256;

export function PlateThumbnail({ plateId, label, session, service, disabled, onSelect, progress }: {
  plateId: string; label: string; session: PlateSessionSnapshot; service: PlateThumbnailService;
  disabled: boolean; onSelect: () => void; progress?: number;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [modelRevision, setModelRevision] = useState(0);
  const [image, setImage] = useState<{ key: string; url: string }>();
  const structure = useObjectListStore(s => s.structure);
  const filaments = useFilamentSessionStore(s => s.snapshot);
  useEffect(() => glVolumeCollection.subscribe(() => setModelRevision(r => r + 1)), []);
  const projection = useMemo(() => projectPlateThumbnail(plateId, glVolumeCollection.volumes, structure, session, filaments),
    [plateId, structure, session, filaments, modelRevision]);
  const key = projection.key;
  useEffect(() => {
    const button = ref.current;
    if (!button) return;
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => setVisible(entries[0]?.isIntersecting ?? false));
    observer?.observe(button);
    if (!observer) setVisible(true);
    return () => observer?.disconnect();
  }, []);
  useEffect(() => {
    if (!projection.parts.length) { service.remove(plateId); return; }
    if (!visible) return;
    let live = true;
    void service.request(plateId, projection.key, projection.parts, THUMBNAIL_RENDER_SIZE).then(url => {
      if (live && url) setImage({ key, url });
    });
    return () => { live = false; };
  }, [visible, key, projection, plateId, service]);
  return <button ref={ref} type="button" className="relative block aspect-square w-full overflow-hidden rounded bg-secondary"
    disabled={disabled} aria-label={`Select ${label}`} onClick={onSelect} data-testid={`plate-thumbnail-${plateId}`}>
    {image?.key === key && projection.parts.length > 0 && <img src={image.url} alt={`Model thumbnail for ${label}`} className="size-full object-contain" draggable={false} />}
    {progress !== undefined && <span className="plate-list-progress absolute inset-x-0 bottom-0 pointer-events-none" style={{ height: `${Math.max(0, Math.min(100, progress))}%` }} />}
  </button>;
}
