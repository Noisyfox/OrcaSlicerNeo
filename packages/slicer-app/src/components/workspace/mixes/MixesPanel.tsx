import { useState } from 'react';
import { Pencil, TriangleAlert } from 'lucide-react';
import type {
  FilamentSessionSlot,
  MixedFilamentRequest,
  FilamentMutationResultOrError,
} from '@slicer/client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { FilamentSwatch, filamentSlotNumberStyle } from '../FilamentSwatch';
import { MixEditor, mixSwatchDisplay } from './MixEditor';

export function MixesPanel({
  slots,
  revision,
  pending,
  mutate,
  onMerge,
  onDelete,
}: {
  slots: readonly FilamentSessionSlot[];
  revision: number;
  pending: boolean;
  mutate: (request: MixedFilamentRequest) => Promise<FilamentMutationResultOrError>;
  onMerge: (slot: number, destination: number) => void;
  onDelete: (slot: number) => void;
}) {
  const [editor, setEditor] = useState<{ slot?: FilamentSessionSlot; revision: number }>();
  const [deleteRevision, setDeleteRevision] = useState<number>();
  const mixes = slots.filter((s) => s.mix);
  const reason =
    slots.length - mixes.length < 2
      ? 'Add a second physical filament in Material to create a mix.'
      : slots.length >= 32
        ? 'Creating a mix requires fewer than 32 project slots.'
        : '';
  return (
    <div className="grid gap-1 text-xs">
      <div className="flex h-8 items-center gap-1">
        <Button
          variant="secondary"
          size="xs"
          disabled={pending || !!reason}
          onClick={() => setEditor({ revision })}
        >
          Create
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={pending || !mixes.length}
          onClick={() => setDeleteRevision(revision)}
        >
          Delete all
        </Button>
      </div>
      {reason && <p className="text-muted-foreground">{reason}</p>}
      {mixes.map((s) => {
        const mix = s.mix!;
        const order = mix.components.map((id, i) => ({ id, i }));
        if (
          mix.gradient &&
          (mix.points.length ? mix.points[0].y < mix.points[mix.points.length - 1].y : mix.reverse)
        )
          order.reverse();
        const components = order.map(({ id, i }) => ({
          id,
          display: slots[id - 1]?.colour.display,
          ratio: mix.gradient ? '' : ` · ${mix.ratios[i]}%`,
        }));
        const summary = components.map(({ id, ratio }) => `${id ? `Slot ${id}` : 'Missing filament'}${ratio}`)
          .join(mix.gradient ? ' → ' : ', ');
        const description = mix.error ? `${summary}. ${mix.error}` : summary;
        return (
          <ContextMenu key={s.logicalId}>
            <ContextMenuTrigger
              render={<button type="button" disabled={pending} />}
              className="filament-slot-item w-full text-left focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring disabled:opacity-50"
              aria-label={`Edit mix in slot ${s.slot}`}
              aria-description={description}
              title={description}
              onClick={() => setEditor({ slot: s, revision })}
            >
              <span
                className="filament-slot-number"
                style={filamentSlotNumberStyle(mixSwatchDisplay(s.colour.effective, mix.ramp), s.colour.effective)}
              >
                {s.slot}
              </span>
              <span className="sidebar-dropdown flex-1 rounded-l-none!">
                <span className="min-w-0 flex-1 truncate">
                  {components.map(({ id, display, ratio }, j) => (
                    <span key={j} className="mr-2 inline-flex items-center gap-1 last:mr-0">
                      {j > 0 && mix.gradient && '→'}
                      {display && (
                        <FilamentSwatch
                          className="size-2.5 shrink-0 rounded-sm border"
                          display={display}
                        />
                      )}
                      <span className={id ? undefined : 'text-destructive'}>{id || 'Missing filament'}{ratio}</span>
                    </span>
                  ))}
                </span>
                {mix.error
                  ? <TriangleAlert className="sidebar-dropdown-arrow text-destructive!" aria-hidden="true" />
                  : <Pencil className="sidebar-dropdown-arrow" aria-hidden="true" />}
              </span>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem disabled={pending} onClick={() => setEditor({ slot: s, revision })}>
                Edit
              </ContextMenuItem>
              <ContextMenuSub>
                <ContextMenuSubTrigger disabled={pending}>Merge with…</ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  {slots
                    .filter((d) => d !== s)
                    .map((d) => (
                      <ContextMenuItem key={d.logicalId} onClick={() => onMerge(s.slot, d.slot)}>
                        Slot {d.slot}
                      </ContextMenuItem>
                    ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
              <ContextMenuItem variant="destructive" disabled={pending} onClick={() => onDelete(s.slot)}>
                Delete
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
      {editor && (
        <MixEditor
          slots={slots}
          initial={editor.slot?.mix ?? undefined}
          onClose={() => setEditor(undefined)}
          onSave={async (recipe) => {
            const result = await mutate({
              version: 1,
              revision: editor.revision,
              slot: editor.slot?.slot,
              recipe,
            });
            return result.ok ? null : result.error;
          }}
        />
      )}
      {deleteRevision !== undefined && (
        <Dialog
          open
          onOpenChange={(v) => {
            if (!v) setDeleteRevision(undefined);
          }}
        >
          <DialogContent className="w-[min(95vw,28rem)]">
            <DialogHeader>
              <DialogTitle>
                Delete all {mixes.length} {mixes.length === 1 ? 'mix' : 'mixes'}?
              </DialogTitle>
              <DialogDescription>
                Assignments will fall back to slot 1 and facets painted with these mixes will lose their paint.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteRevision(undefined)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={pending}
                onClick={() => {
                  void mutate({ version: 1, revision: deleteRevision, operation: 'delete-all' });
                  setDeleteRevision(undefined);
                }}
              >
                Delete all
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
