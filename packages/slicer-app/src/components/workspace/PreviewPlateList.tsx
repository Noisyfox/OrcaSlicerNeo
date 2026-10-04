import { useEffect, useMemo, useState } from 'react';
import type { PlateSessionSnapshot } from '@slicer/client';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { projectPreviewPlateList } from './previewPlateListProjection';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { PlateThumbnail } from './PlateThumbnail';
import { createThumbnailRenderer, PlateThumbnailService } from './plateThumbnailService';
import { formatPreviewTime } from './viewport/PreviewInspectionPanel';

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
  const failures = useSlicerStore(s => s.plateFailures);
  const activeTarget = useSlicerStore(s => s.activeSliceTarget);
  const progress = useSlicerStore(s => s.progress);
  const progressText = useSlicerStore(s => s.progressText);
  const [selecting, setSelecting] = useState<string | null>(null);
  const items = useMemo(() => projectPreviewPlateList(snapshot, results, { target: activeTarget, progress, text: progressText }, failures),
    [results, snapshot, activeTarget, progress, progressText, failures]);
  const metric = (value: number | undefined, suffix: string) => Number.isFinite(value) ? `${value!.toFixed(2)}${suffix}` : '—';
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
                disabled={disabled} onSelect={() => void handleSelect(item.plate.plateId)} progress={item.progress} />}
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
                <Badge variant={item.status === 'sliced' ? 'default' : item.status === 'out-of-bounds' || item.status === 'error' ? 'destructive' : 'secondary'}
                  data-plate-state={item.status} title={item.progressText || item.error}>
                  {selecting === item.plate.plateId ? 'Loading…' : item.detail}
                </Badge>
              </div>
              <CardDescription className="flex flex-col gap-1 tabular-nums">
                <span data-testid={`plate-time-${item.plate.plateId}`}>{formatPreviewTime(item.summary?.estimatedTimeSeconds)?.replaceAll(' ', '') ?? '—'}</span>
                <span>{metric(item.summary?.filamentLengthMeters, 'm')} | {metric(item.summary?.filamentWeightGrams, 'g')}</span>
                {item.progress !== undefined && <span role="progressbar" aria-label={`Slicing ${item.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress)}>{Math.round(item.progress)}%</span>}
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
