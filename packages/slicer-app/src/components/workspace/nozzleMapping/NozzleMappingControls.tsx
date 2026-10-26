import { useEffect, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import type { NozzleMappingChange, NozzleMappingSnapshot } from '@slicer/client';
import { Input } from '@/components/ui/input';
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
    labels={Object.fromEntries(rack?.slots.map(s => [s.slot, s.preset.name]) ?? [])}
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
  const save = () => {
    const value = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
      setError('Enter a whole number from 1 to 2147483647.'); return;
    }
    setError(null);
    if (value !== capacity) void commit({ kind: 'capacity', nozzle, capacity: value }).then(accepted => {
      if (!accepted) setText(String(capacity));
    });
  };
  return <div className="space-y-1">
    <label className="flex items-center gap-2 text-xs">Total filament slots
      <Input className="h-6 min-w-0 flex-1" inputMode="numeric" data-testid="nozzle-capacity"
        aria-label={`Total filament slots for nozzle ${nozzle}`} value={text}
        disabled={disabled || parentDisabled} aria-invalid={!!error}
        onChange={e => setText(e.target.value)} onBlur={save}
        onKeyDown={e => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') { setText(String(capacity)); setError(null); }
        }} />
    </label>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}
