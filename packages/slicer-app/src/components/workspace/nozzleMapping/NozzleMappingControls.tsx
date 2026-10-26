import { useEffect, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import type { NozzleMappingChange, NozzleMappingSnapshot } from '@slicer/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Minus, Plus } from 'lucide-react';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { useHistoryRestoreStore } from '@/stores/useHistoryRestoreStore';
import { NozzleMappingEditor } from './NozzleMappingEditor';
import { commitNozzleMapping } from './nozzleMappingActions';
import { useNozzleMapping } from './useNozzleMapping';

export function useMappingCommit(snapshot: NozzleMappingSnapshot | null, revision: number | undefined) {
  const platform = usePlatform();
  const [pending, setPending] = useState(false);
  const mutating = useProjectStore(s => s.projectMutationPendingCount > 0 || ['loading', 'saving', 'model-import', 'waiting-for-dirty-decision'].includes(s.operation.phase));
  const slicing = useSlicerStore(s => s.status === 'slicing');
  const restoring = useHistoryRestoreStore(s => s.phase !== 'idle');
  const disabled = pending || mutating || slicing || restoring || !snapshot || revision === undefined;
  return { disabled, commit: async (change: NozzleMappingChange) => {
    if (disabled || !snapshot || revision === undefined) return false;
    setPending(true);
    try { await commitNozzleMapping(platform, snapshot, revision, change); return true; }
    catch (error) { useSlicerStore.getState().setError(String(error)); return false; }
    finally { setPending(false); }
  } };
}

export function PlateNozzleMapping({ snapshot, revision }: { snapshot: NozzleMappingSnapshot; revision: number | undefined }) {
  const rack = useFilamentSessionStore(s => s.snapshot);
  const { disabled, commit } = useMappingCommit(snapshot, revision);
  return <NozzleMappingEditor snapshot={snapshot} disabled={disabled}
    slots={rack?.slots}
    onMode={mode => void commit({ kind: 'mode', mode })}
    onMapping={filamentMap => void commit({ kind: 'mapping', filamentMap })} />;
}

/** Total slots belong to the project; the upper Multi. selector supplies the
 * physical nozzle. It does not constrain the independent Plate mapping rows. */
export function NozzleCapacityInput({ nozzle, disabled: parentDisabled }: { nozzle: number; disabled?: boolean }) {
  const { snapshot, revision } = useNozzleMapping();
  const capacity = snapshot?.nozzles.find(n => n.id === nozzle)?.capacity;
  if (!snapshot?.eligible || capacity === undefined) return null;
  // The projection contains every nozzle. Keep its subscription mounted when
  // selecting a head; reset only the local input draft, without another read
  // or a loading gap that removes the row and shifts the Sidebar.
  return <NozzleCapacityField key={nozzle} nozzle={nozzle} capacity={capacity}
    snapshot={snapshot} revision={revision} disabled={parentDisabled} />;
}

function NozzleCapacityField({ nozzle, capacity, snapshot, revision, disabled: parentDisabled }: {
  nozzle: number; capacity: number; snapshot: NozzleMappingSnapshot;
  revision: number | undefined; disabled?: boolean;
}) {
  const { disabled, commit } = useMappingCommit(snapshot, revision);
  const [text, setText] = useState(String(capacity));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setText(String(capacity)); setError(null); }, [capacity]);
  const save = (draft = text) => {
    const value = Number(draft);
    if (!/^\d+$/.test(draft) || !Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
      setError('Enter a whole number from 1 to 2147483647.'); return;
    }
    setError(null);
    if (value !== capacity) void commit({ kind: 'capacity', nozzle, capacity: value }).then(accepted => {
      if (!accepted) setText(String(capacity));
    });
  };
  const controlDisabled = disabled || parentDisabled;
  const numericDraft = /^\d+$/.test(text) ? Number(text) : NaN;
  const canStep = Number.isSafeInteger(numericDraft) && numericDraft >= 1 && numericDraft <= 2147483647;
  const adjust = (direction: number) => {
    const next = String(numericDraft + direction);
    setText(next); save(next);
  };
  return <div className="space-y-1">
    <div className="grid min-h-7 grid-cols-[minmax(0,1fr)_minmax(0,40%)] items-center gap-2 px-1 py-0.5">
      <label htmlFor="nozzle-capacity" className="min-w-0 truncate text-[13px] font-normal text-muted-foreground">Total filament slots</label>
      <div className="flex h-6 min-w-0 items-center rounded-sm bg-control-background focus-within:ring-1 focus-within:ring-ring">
        <Input id="nozzle-capacity" className="h-6 min-w-0 flex-1 rounded-sm border-0 bg-transparent dark:bg-transparent px-1.5 text-[13px] focus-visible:ring-0 md:text-[13px]" inputMode="numeric" data-testid="nozzle-capacity"
          aria-label={`Total filament slots for nozzle ${nozzle}`} value={text}
          disabled={controlDisabled} aria-invalid={!!error}
          onChange={e => setText(e.target.value)} onBlur={() => save()}
          onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') { setText(String(capacity)); setError(null); }
          }} />
        <div className="flex shrink-0 gap-px pr-0.5">
          <Button type="button" variant="number-stepper" size="icon-xs" className="size-[18px] rounded-l-[2px] rounded-r-none [&>svg]:size-3"
            aria-label="Decrease total filament slots" disabled={controlDisabled || !canStep || numericDraft <= 1}
            onPointerDown={event => event.preventDefault()} onClick={() => adjust(-1)}><Minus /></Button>
          <Button type="button" variant="number-stepper" size="icon-xs" className="size-[18px] rounded-l-none rounded-r-[2px] [&>svg]:size-3"
            aria-label="Increase total filament slots" disabled={controlDisabled || !canStep || numericDraft >= 2147483647}
            onPointerDown={event => event.preventDefault()} onClick={() => adjust(1)}><Plus /></Button>
        </div>
      </div>
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}
