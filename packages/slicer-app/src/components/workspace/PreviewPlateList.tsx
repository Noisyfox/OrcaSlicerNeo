import { useEffect, useMemo, useState } from 'react';
import type { PlateSessionSnapshot } from '@slicer/client';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { projectPreviewPlateList } from './previewPlateListProjection';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { PlateThumbnail } from './PlateThumbnail';
import { createThumbnailRenderer, PlateThumbnailService } from './plateThumbnailService';

export function PreviewPlateList({
  snapshot,
  pending = false,
  onSelect,
}: {
  snapshot: PlateSessionSnapshot;
  pending?: boolean;
  onSelect: (plateId: string) => Promise<void> | void;
}) {
  const results = useSlicerStore((state) => state.plateResults);
  const [selecting, setSelecting] = useState<string | null>(null);
  const items = useMemo(() => projectPreviewPlateList(snapshot, results), [results, snapshot]);
  const disabled = pending || selecting !== null;
  const [thumbnails, setThumbnails] = useState<PlateThumbnailService>();
  useEffect(() => {
    const renderer = createThumbnailRenderer();
    const service = new PlateThumbnailService(renderer.render);
    setThumbnails(service);
    return () => { service.dispose(); renderer.dispose(); };
  }, []);
  useEffect(() => thumbnails?.retain(snapshot.plates.map(p => p.plateId)), [snapshot, thumbnails]);

  async function handleSelect(plateId: string) {
    if (disabled) return;
    setSelecting(plateId);
    try {
      await onSelect(plateId);
    } finally {
      setSelecting(null);
    }
  }

  return (
    <section className="plate-list px-2 py-2" aria-label="Plates" data-testid="preview-plate-list">
      <div role="listbox" aria-label="Plates" aria-activedescendant={`preview-plate-${snapshot.currentPlateId}`}>
        {items.map((item) => (
          <Card key={item.plate.plateId} size="sm" className="plate-list-card" data-current={item.current} data-plate-status={item.status}>
            <CardContent className="plate-list-thumbnail">
              {thumbnails && <PlateThumbnail plateId={item.plate.plateId} label={item.label} session={snapshot} service={thumbnails}
                disabled={disabled} onSelect={() => void handleSelect(item.plate.plateId)} />}
            </CardContent>
            <CardHeader className="plate-list-details">
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-1">
                <CardTitle className="min-w-0">
                  <button id={`preview-plate-${item.plate.plateId}`} type="button" role="option" aria-selected={item.current}
                    aria-label={`${item.label}, ${item.detail}${item.current ? ', current plate' : ''}`}
                    data-testid={`preview-plate-${item.plate.plateId}`} data-plate-status={item.status}
                    disabled={disabled} onClick={() => void handleSelect(item.plate.plateId)} className="max-w-full truncate text-left">
                    {item.label}
                  </button>
                </CardTitle>
                <Badge variant={item.status === 'sliced' ? 'default' : item.status === 'out-of-bounds' ? 'destructive' : 'secondary'}>
                  {selecting === item.plate.plateId ? 'Loading…' : item.detail}
                </Badge>
              </div>
              <CardDescription className="flex flex-col gap-1 tabular-nums">
                <span>—</span><span>— | —</span>
              </CardDescription>
            </CardHeader>
            <CardFooter className="plate-list-actions">
              <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void handleSelect(item.plate.plateId)}>Select</Button>
            </CardFooter>
          </Card>
        ))}
      </div>
    </section>
  );
}
