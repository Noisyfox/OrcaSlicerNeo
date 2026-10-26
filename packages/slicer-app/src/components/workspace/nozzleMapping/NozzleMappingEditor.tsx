import type { FilamentSessionSlot, NozzleMappingMode, NozzleMappingSnapshot } from '@slicer/client';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { filamentNumberColour, filamentSwatchStyle } from '../FilamentSwatch';

export const mappingModeLabel = (mode: NozzleMappingMode) => mode === 0 ? 'Auto For Flush' : mode === 1 ? 'Auto For Match' : 'Manual';

export function NozzleMappingModeControl({ snapshot, disabled, onChange }: {
  snapshot: NozzleMappingSnapshot; disabled?: boolean; onChange: (mode: NozzleMappingMode) => void;
}) {
  const current = snapshot.effective.mode;
  const modes = snapshot.modes.filter(m => m.mode === 0 || m.mode === 2 || m.mode === current && m.mode === 1);
  const selected = snapshot.modes.find(m => m.mode === current);
  return <div className="space-y-1">
    <ToggleGroup value={[String(current === 3 ? 2 : current)]} disabled={disabled}
      aria-label="Filament mapping mode" data-testid="mapping-mode" spacing={1}
      className="w-full rounded-sm bg-control-background p-0.5"
      onValueChange={values => { if (values[0]) onChange(Number(values[0]) as NozzleMappingMode); }}>
      {modes.map(m => <ToggleGroupItem key={m.mode} value={String(m.mode)} disabled={!m.available}
        data-testid={`mapping-mode-${m.mode}`} title={m.reason || mappingModeLabel(m.mode)}
        className="h-6 min-w-0 flex-1 rounded-sm px-1 text-xs text-muted-foreground aria-pressed:bg-secondary aria-pressed:text-foreground">
        <span className="truncate">{mappingModeLabel(m.mode)}</span>
      </ToggleGroupItem>)}
    </ToggleGroup>
    {selected && !selected.available && <p role="alert" className="text-xs text-destructive">{selected.reason}</p>}
  </div>;
}

/** The same controlled editor serves immediate Sidebar edits and a temporary
 * confirmation draft. Hidden unused entries always travel with the full map. */
export function NozzleMappingEditor({ snapshot, filamentMap = snapshot.effective.filamentMap,
  disabled, onMode, onMapping, slots = [] }: {
  snapshot: NozzleMappingSnapshot; filamentMap?: readonly number[]; disabled?: boolean;
  onMode?: (mode: NozzleMappingMode) => void; onMapping: (map: readonly number[]) => void;
  slots?: readonly FilamentSessionSlot[];
}) {
  if (!snapshot.eligible) return null;
  const manual = snapshot.effective.mode === 2 || snapshot.effective.mode === 3;
  const overCapacity = manual ? snapshot.nozzles.filter(n => snapshot.usedFilaments.filter(id => filamentMap[id - 1] === n.id).length > n.capacity) : [];
  return <div className="space-y-2 p-2" data-testid="nozzle-mapping-editor">
    {onMode ? <NozzleMappingModeControl snapshot={snapshot} disabled={disabled} onChange={onMode} /> :
      <p className="text-xs text-muted-foreground">{mappingModeLabel(snapshot.effective.mode)}</p>}
    {manual && <div className="space-y-1" data-testid="mapping-materials">
      {snapshot.usedFilaments.length === 0 && <p className="text-xs text-muted-foreground">This plate uses no filaments.</p>}
      {snapshot.usedFilaments.map(id => {
        const slot = slots.find(s => s.slot === id);
        return <div key={id} className="flex items-center gap-2">
          <div className="flex h-6 min-w-0 flex-1 items-center overflow-hidden rounded-sm bg-control-background"
            title={slot?.preset.name} data-testid={`mapping-material-${id}`}>
            <span className="flex h-full w-6 shrink-0 items-center justify-center text-xs"
              style={slot ? { ...filamentSwatchStyle(slot.colour.display), color: filamentNumberColour(slot.colour.effective) } : undefined}>
              {id}
            </span>
            <span className="min-w-0 truncate px-1.5 text-xs">{slot?.preset.label || slot?.preset.name || 'Filament'}</span>
          </div>
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
        </div>;
      })}
    </div>}
    {overCapacity.map(n => <p key={n.id} role="status" className="text-xs text-amber-600">
      Nozzle {n.id}: mapped filaments exceed its {n.capacity} slots. You can still slice.
    </p>)}
    {snapshot.diagnostics.filter(d => d.code !== 'capacity_exceeded').map((d, i) =>
      <p key={i} role={d.severity === 'error' ? 'alert' : 'status'} className="text-xs text-muted-foreground">{d.message}</p>)}
  </div>;
}
