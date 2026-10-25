import type { NozzleMappingMode, NozzleMappingSnapshot } from '@slicer/client';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export const mappingModeLabel = (mode: NozzleMappingMode) => mode === 0 ? 'Auto For Flush' : mode === 1 ? 'Auto For Match' : 'Manual';

export function NozzleMappingModeSelect({ snapshot, disabled, onChange }: {
  snapshot: NozzleMappingSnapshot; disabled?: boolean; onChange: (mode: NozzleMappingMode) => void;
}) {
  const current = snapshot.effective.mode;
  const modes = snapshot.modes.filter(m => m.mode === 0 || m.mode === 2 || m.mode === current && m.mode === 1);
  const selected = snapshot.modes.find(m => m.mode === current);
  return <div className="space-y-1">
    <Select value={String(current === 3 ? 2 : current)} disabled={disabled}
      onValueChange={value => { if (value !== null) onChange(Number(value) as NozzleMappingMode); }}>
      <SelectTrigger variant="sidebar" className="w-full" aria-label="Filament mapping mode" data-testid="mapping-mode">
        <SelectValue>{mappingModeLabel(current)}</SelectValue>
      </SelectTrigger>
      <SelectContent data-testid="mapping-mode-options"><SelectGroup>{modes.map(m =>
        <SelectItem key={m.mode} value={String(m.mode)} disabled={!m.available} title={m.reason || undefined}>
          {mappingModeLabel(m.mode)}{!m.available ? ' (unavailable)' : ''}
        </SelectItem>)}</SelectGroup></SelectContent>
    </Select>
    {selected && !selected.available && <p role="alert" className="text-xs text-destructive">{selected.reason}</p>}
  </div>;
}

/** The same controlled editor serves immediate Sidebar edits and a temporary
 * confirmation draft. Hidden unused entries always travel with the full map. */
export function NozzleMappingEditor({ snapshot, filamentMap = snapshot.effective.filamentMap,
  disabled, onMode, onMapping, labels = {} }: {
  snapshot: NozzleMappingSnapshot; filamentMap?: readonly number[]; disabled?: boolean;
  onMode?: (mode: NozzleMappingMode) => void; onMapping: (map: readonly number[]) => void;
  labels?: Readonly<Record<number, string>>;
}) {
  if (!snapshot.eligible) return null;
  const manual = snapshot.effective.mode === 2 || snapshot.effective.mode === 3;
  const overCapacity = manual ? snapshot.nozzles.filter(n => snapshot.usedFilaments.filter(id => filamentMap[id - 1] === n.id).length > n.capacity) : [];
  return <div className="space-y-2 p-2" data-testid="nozzle-mapping-editor">
    {onMode ? <NozzleMappingModeSelect snapshot={snapshot} disabled={disabled} onChange={onMode} /> :
      <p className="text-xs text-muted-foreground">{mappingModeLabel(snapshot.effective.mode)}</p>}
    {manual && <div className="space-y-1" data-testid="mapping-materials">
      {snapshot.usedFilaments.length === 0 && <p className="text-xs text-muted-foreground">This plate uses no filaments.</p>}
      {snapshot.usedFilaments.map(id => <div key={id} className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs" title={labels[id]}>#{id} {labels[id] ?? 'Filament'}</span>
        <Select value={String(filamentMap[id - 1])} disabled={disabled} onValueChange={value => {
          if (value === null) return;
          const next = [...filamentMap]; next[id - 1] = Number(value); onMapping(next);
        }}>
          <SelectTrigger variant="sidebar" className="w-28 shrink-0" aria-label={`Nozzle for filament ${id}`} data-testid={`mapping-filament-${id}`}>
            <SelectValue>Nozzle {filamentMap[id - 1]}</SelectValue>
          </SelectTrigger>
          <SelectContent><SelectGroup>{snapshot.nozzles.map(n =>
            <SelectItem key={n.id} value={String(n.id)}>Nozzle {n.id}</SelectItem>
          )}</SelectGroup></SelectContent>
        </Select>
      </div>)}
    </div>}
    {overCapacity.map(n => <p key={n.id} role="status" className="text-xs text-amber-600">
      Nozzle {n.id}: mapped filaments exceed its {n.capacity} slots. You can still slice.
    </p>)}
    {snapshot.diagnostics.filter(d => d.code !== 'capacity_exceeded').map((d, i) =>
      <p key={i} role={d.severity === 'error' ? 'alert' : 'status'} className="text-xs text-muted-foreground">{d.message}</p>)}
  </div>;
}
