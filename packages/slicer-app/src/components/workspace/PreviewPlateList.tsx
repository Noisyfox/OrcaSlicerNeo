import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlateSessionSnapshot, SliceResultReceipt } from '@slicer/client';
import { usePlatform } from '@orca/platform-contract';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { projectPreviewPlateList } from './previewPlateListProjection';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { PlateThumbnail } from './PlateThumbnail';
import { createThumbnailRenderer, PlateThumbnailService } from './plateThumbnailService';
import { formatPreviewTime } from './viewport/PreviewInspectionPanel';
import { cancelSlice, sliceModel } from './actions/sliceActions';
import { SendGcodeDialog, type SendGcodeAction } from '../send/SendGcodeDialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { usePaintingPhase } from './viewport/gizmo/painting/PaintingProvider';
import { useProjectStore } from '@/stores/useProjectStore';
import { useHistoryRestoreStore } from '@/stores/useHistoryRestoreStore';
import { Send } from 'lucide-react';
import { usePlateListViewStore } from '@/stores/usePlateListViewStore';

export function PreviewPlateList({
  snapshot,
  pending = false,
  onSelect,
}: {
  snapshot: PlateSessionSnapshot;
  pending?: boolean;
  onSelect: (plateId: string) => Promise<void> | void;
}) {
  const platform = usePlatform();
  const paintingPhase = usePaintingPhase();
  const mutationPending = useProjectStore(s => s.projectMutationPendingCount > 0);
  const restoring = useHistoryRestoreStore(s => s.phase !== 'idle');
  const operation = useRef(false);
  const [acting, setActing] = useState<string | null>(null);
  const [send, setSend] = useState<{ receipt: SliceResultReceipt; action: SendGcodeAction }>();
  const [reviewId, setReviewId] = useState<string>();
  const results = useSlicerStore((state) => state.plateResults);
  const failures = useSlicerStore(s => s.plateFailures);
  const activeTarget = useSlicerStore(s => s.activeSliceTarget);
  const progress = useSlicerStore(s => s.progress);
  const progressText = useSlicerStore(s => s.progressText);
  const [selecting, setSelecting] = useState<string | null>(null);
  const items = useMemo(() => projectPreviewPlateList(snapshot, results, { target: activeTarget, progress, text: progressText }, failures),
    [results, snapshot, activeTarget, progress, progressText, failures]);
  const metric = (value: number | undefined, suffix: string) => Number.isFinite(value) ? `${value!.toFixed(2)}${suffix}` : '—';
  const disabled = pending || selecting !== null || paintingPhase !== 'closed' || mutationPending || restoring;
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
  async function handleSlice(plateId: string) {
    if (disabled || operation.current || useSlicerStore.getState().activeSliceTarget) return;
    operation.current = true; setActing(plateId);
    try { await sliceModel(platform, plateId); }
    catch (error) { useSlicerStore.getState().setError(String(error)); }
    finally { operation.current = false; setActing(null); }
  }
  const review = items.find(item => item.plate.plateId === reviewId);
  const query = usePlateListViewStore(s => s.query).trim().toLocaleLowerCase();
  const visibleItems = items.filter(item => item.label.toLocaleLowerCase().includes(query));

  return (
    <section className="plate-list pb-2" aria-label="Plates" data-testid="preview-plate-list">
      <div role="listbox" aria-label="Plates" aria-activedescendant={visibleItems.some(item => item.current) ? `preview-plate-${snapshot.currentPlateId}` : undefined}>
        {visibleItems.map((item) => (
          <Card key={item.plate.plateId} size="sm" className="plate-list-card cursor-pointer ring-0" data-current={item.current} data-plate-status={item.status}
            onClick={event => {
              // Buttons own their actions, including the keyboard-accessible name and thumbnail selectors.
              if ((event.target as Element).closest('button')) return;
              void handleSelect(item.plate.plateId);
            }}>
            <CardContent className="plate-list-thumbnail">
              {thumbnails && <PlateThumbnail plateId={item.plate.plateId} label={item.label} session={snapshot} service={thumbnails}
                disabled={disabled} onSelect={() => void handleSelect(item.plate.plateId)} progress={item.progress} />}
            </CardContent>
            <CardHeader className="plate-list-details">
              <div className="flex min-w-0 items-start justify-between gap-1">
                <CardTitle className="min-w-0 flex-1">
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
              {item.status === 'sliced' ? <>
                <Button size="icon-sm" variant="secondary" aria-label={`Send ${item.label}`} disabled={disabled || activeTarget !== null || acting !== null}
                  onClick={() => setSend({ receipt: results[item.plate.plateId].receipt, action: 'send' })}><Send data-icon="inline-start" /></Button>
                <Button size="sm" disabled={disabled || activeTarget !== null || acting !== null} aria-label={`Print ${item.label}`} data-testid={`plate-print-${item.plate.plateId}`}
                  onClick={() => setSend({ receipt: results[item.plate.plateId].receipt, action: 'send-and-print' })}>Print</Button>
              </> : item.status === 'slicing' ?
                <Button size="sm" variant="secondary" aria-label={`Cancel slicing ${item.label}`} disabled={platform.runtime.getRuntimeExecutionState?.().threaded === false}
                  title={platform.runtime.getRuntimeExecutionState?.().threaded === false ? 'Cancellation requires the threaded runtime' : undefined}
                  onClick={() => { if (useSlicerStore.getState().activeSliceTarget?.plateId === item.plate.plateId) void cancelSlice(platform); }}>Cancel</Button>
                : item.status === 'error' || item.status === 'out-of-bounds' ?
                  <Button size="sm" variant="destructive" aria-label={`Review ${item.label}`} onClick={() => setReviewId(item.plate.plateId)}>Review</Button>
                  : <Button size="sm" aria-label={`Slice ${item.label}`} data-testid={`plate-slice-${item.plate.plateId}`}
                      disabled={disabled || activeTarget !== null || acting !== null || item.status === 'empty'} onClick={() => void handleSlice(item.plate.plateId)}>
                    {acting === item.plate.plateId ? 'Starting…' : 'Slice'}
                  </Button>}
            </CardFooter>
          </Card>
        ))}
      </div>
      {visibleItems.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground" role="status">No matching plates</p>}
      {send && <SendGcodeDialog open action={send.action} targetReceipt={send.receipt} onClose={() => setSend(undefined)} />}
      <Dialog open={reviewId !== undefined} onOpenChange={open => { if (!open) setReviewId(undefined); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{review?.label ?? 'Plate'} — Review</DialogTitle>
            <DialogDescription>{review?.error ?? (review?.status === 'out-of-bounds' ? 'One or more instances are outside the printable area. Move them inside the plate before slicing.' : 'This plate no longer has a current slicing error.')}</DialogDescription>
          </DialogHeader>
          <Button disabled={disabled || !review} onClick={async () => { if (review) await handleSelect(review.plate.plateId); setReviewId(undefined); }}>Select plate</Button>
          {review?.status === 'error' && <Button disabled={disabled || activeTarget !== null || acting !== null} onClick={() => {
            setReviewId(undefined); void handleSlice(review.plate.plateId);
          }}>Retry slice</Button>}
        </DialogContent>
      </Dialog>
    </section>
  );
}
