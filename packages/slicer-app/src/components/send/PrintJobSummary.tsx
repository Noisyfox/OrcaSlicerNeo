import { useEffect, useState, type ReactNode } from 'react';
import { Box, Clock3, Pencil, Printer, RefreshCw, Weight } from 'lucide-react';
import type { PrintRequirements, SavedPrinter } from '@orca/printer-control/domain';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import { useObjectListStore } from '../workspace/objectList/useObjectListStore';
import { glVolumeCollection } from '../workspace/viewport/GLVolume';
import { projectPlateThumbnail } from '../workspace/plateThumbnailScene';
import { createThumbnailRenderer, PlateThumbnailService } from '../workspace/plateThumbnailService';

/** One retained plate preview per modal; the modal prevents project edits. */
function PrintThumbnail({ plateId }: { plateId: string | undefined }) {
  const [image, setImage] = useState<{ plateId: string; url: string }>();
  const session = usePlateSessionStore(s => s.snapshot);
  useEffect(() => {
    if (!plateId || !session) return;
    const projection = projectPlateThumbnail(plateId, glVolumeCollection.volumes,
      useObjectListStore.getState().structure, session, useFilamentSessionStore.getState().snapshot);
    if (!projection.parts.length) return;
    const renderer = createThumbnailRenderer(), service = new PlateThumbnailService(renderer.render);
    let active = true;
    void service.request(plateId, projection.key, projection.parts, 256).then(url => {
      if (active && url) setImage({ plateId, url });
    });
    return () => { active = false; service.dispose(); renderer.dispose(); };
  }, [plateId, session]);
  return <div className="flex aspect-square w-full items-center justify-center" data-testid="print-job-thumbnail">
    {image?.plateId === plateId && image ? <img src={image.url} alt="Print model preview" className="size-full object-contain" />
      : <Box className="size-24 text-muted-foreground/40" aria-label="Model preview unavailable" strokeWidth={1} />}
  </div>;
}

export function PrintJobSummary({ requirements, printer, printerControl, name, onNameChange, disabled, onRefresh, route }: {
  requirements: PrintRequirements | null; printer: SavedPrinter; printerControl?: ReactNode;
  name: string; onNameChange(name: string): void; disabled: boolean; onRefresh(): void; route?: string | null;
}) {
  const session = usePlateSessionStore(s => s.snapshot);
  const structure = useObjectListStore(s => s.structure);
  const firstObject = session?.instances.find(instance => instance.member && instance.plateId === requirements?.plateId && !instance.unprintable);
  const displayName = name || structure.find(object => object.id === firstObject?.objectId)?.name || 'Untitled print';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const commit = () => { if (draft.trim()) onNameChange(draft.trim()); setEditing(false); };
  const minutes = requirements ? Math.ceil(requirements.durationSeconds / 60) : 0;
  return <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-5 sm:grid-cols-[180px_minmax(0,1fr)]" data-testid="print-job-summary">
    <PrintThumbnail plateId={requirements?.plateId} />
    <div className="min-w-0 space-y-5">
      <div className="space-y-2">
        {editing ? <Input autoFocus aria-label="Print job name" value={draft} disabled={disabled}
          onChange={event => setDraft(event.target.value)} onBlur={commit}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } if (event.key === 'Escape') { event.stopPropagation(); setEditing(false); } }} />
          : <div className="flex min-w-0 items-center gap-1"><span className="truncate font-semibold" title={displayName}>{displayName}</span>
            <Button variant="ghost" size="icon" aria-label="Rename print job" disabled={disabled} onClick={() => { setDraft(displayName); setEditing(true); }}><Pencil className="size-3.5" /></Button></div>}
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm tabular-nums" data-testid="print-job-statistics">
          <span className="flex items-center gap-2"><Clock3 className="size-4 text-muted-foreground" aria-hidden="true" />{requirements ? `${minutes >= 60 ? `${Math.floor(minutes / 60)}h ` : ''}${minutes % 60}m` : '—'}</span>
          <span className="flex items-center gap-2"><Weight className="size-4 text-muted-foreground" aria-hidden="true" />{requirements ? `${requirements.weightGrams.toFixed(2)} g` : '—'}</span>
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><span>Printer</span><span className="h-px flex-1 bg-border" /></div>
        <div className="flex items-stretch gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border p-2">
            <Printer className="hidden size-9 shrink-0 text-muted-foreground sm:block" aria-hidden="true" />
            <div className="min-w-0 flex-1">{printerControl ?? <p className="truncate text-sm font-medium">{printer.identity.displayName}</p>}
              {requirements && <p className="text-xs text-muted-foreground" data-testid="print-build-plate">{requirements.bedType || 'Build plate not specified'}</p>}
              <p className="truncate text-xs text-muted-foreground" title={printer.identity.model ?? requirements?.printerModel}>{printer.identity.model ?? requirements?.printerModel}{requirements && ` · ${requirements.nozzleDiameters.join('/')} mm`}</p>
              {route && <p className="text-xs text-muted-foreground" data-testid="print-delivery-route">{route.toUpperCase()}</p>}
            </div>
            <Button variant="ghost" size="icon" disabled={disabled} aria-label="Refresh printer status" title="Refresh printer status" onClick={onRefresh}><RefreshCw className="size-4 text-primary" /></Button>
          </div>
        </div>
      </div>
    </div>
  </div>;
}
