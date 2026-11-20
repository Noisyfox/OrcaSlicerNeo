import { useState } from 'react';
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
import { colorSwatchForeground, colorSwatchStyle } from '@/components/ui/color-swatch';
import { FilamentSwatch } from '../FilamentSwatch';
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
        return (
          <ContextMenu key={s.logicalId}>
            <ContextMenuTrigger
              render={<button type="button" disabled={pending} />}
              className="flex items-center gap-2 rounded bg-control-background p-1 text-left outline-none hover:bg-button-hover focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
              aria-label={`Edit mix in slot ${s.slot}`}
              onClick={() => setEditor({ slot: s, revision })}
            >
              <span
                className="grid h-7 min-w-9 shrink-0 place-items-center rounded-sm border"
                style={{
                  ...colorSwatchStyle(mixSwatchDisplay(s.colour.effective, mix.ramp)),
                  color: colorSwatchForeground(s.colour.effective),
                }}
              >
                {s.slot}
              </span>
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-1">
                  {order.map(({ id, i }, j) => (
                    <span key={i} className="inline-flex items-center gap-1">
                      {j > 0 && mix.gradient && '→'}
                      {slots[id - 1] && (
                        <FilamentSwatch
                          className="size-2.5 rounded-sm border"
                          display={{ mode: 'solid', colors: [slots[id - 1].colour.effective] }}
                        />
                      )}
                      {id ? `Slot ${id}` : 'Missing filament'}
                      {!mix.gradient && ` · ${mix.ratios[i]}%`}
                    </span>
                  ))}
                </span>
                {mix.error && <span className="text-destructive">{mix.error}</span>}
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
