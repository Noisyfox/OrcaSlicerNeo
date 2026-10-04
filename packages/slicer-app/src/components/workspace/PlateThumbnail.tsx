import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlateSessionSnapshot } from '@slicer/client';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import { useObjectListStore } from './objectList/useObjectListStore';
import { glVolumeCollection } from './viewport/GLVolume';
import { projectPlateThumbnail } from './plateThumbnailScene';
import type { PlateThumbnailService } from './plateThumbnailService';

export function PlateThumbnail({ plateId, label, session, service, disabled, onSelect, progress }: {
  plateId: string; label: string; session: PlateSessionSnapshot; service: PlateThumbnailService;
  disabled: boolean; onSelect: () => void; progress?: number;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [size, setSize] = useState(256);
  const [modelRevision, setModelRevision] = useState(0);
  const [image, setImage] = useState<{ key: string; url: string }>();
  const structure = useObjectListStore(s => s.structure);
  const filaments = useFilamentSessionStore(s => s.snapshot);
  useEffect(() => glVolumeCollection.subscribe(() => setModelRevision(r => r + 1)), []);
  const projection = useMemo(() => projectPlateThumbnail(plateId, glVolumeCollection.volumes, structure, session, filaments),
    [plateId, structure, session, filaments, modelRevision]);
  const key = `${size}:${projection.key}`;
  useEffect(() => {
    const button = ref.current;
    if (!button) return;
    const measure = () => setSize(Math.min(512, Math.max(128, Math.ceil(button.getBoundingClientRect().width * Math.min(2, window.devicePixelRatio || 1)))));
    measure();
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => setVisible(entries[0]?.isIntersecting ?? false));
    observer?.observe(button);
    if (!observer) setVisible(true);
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    resize?.observe(button);
    return () => { observer?.disconnect(); resize?.disconnect(); };
  }, []);
  useEffect(() => {
    if (!projection.parts.length) { service.remove(plateId); return; }
    if (!visible) return;
    let live = true;
    void service.request(plateId, projection.key, projection.parts, size).then(url => {
      if (live && url) setImage({ key, url });
    });
    return () => { live = false; };
  }, [visible, key, projection, plateId, service, size]);
  return <button ref={ref} type="button" className="relative block aspect-square w-full overflow-hidden rounded bg-secondary"
    disabled={disabled} aria-label={`Select ${label}`} onClick={onSelect} data-testid={`plate-thumbnail-${plateId}`}>
    {image?.key === key && projection.parts.length > 0 && <img src={image.url} alt={`Model thumbnail for ${label}`} className="size-full object-contain" draggable={false} />}
    {progress !== undefined && <span className="plate-list-progress absolute inset-x-0 bottom-0 pointer-events-none" style={{ height: `${Math.max(0, Math.min(100, progress))}%` }} />}
  </button>;
}
