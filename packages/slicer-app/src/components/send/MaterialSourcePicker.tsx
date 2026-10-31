import { useEffect, useState } from 'react';
import { Check, ChevronDown, Disc3, Eraser, X } from 'lucide-react';
import type { PrintMaterialRequirement, PrintMaterialSource } from '@orca/printer-control/domain';
import { colorSwatchForeground, colorSwatchStyle } from '@/components/ui/color-swatch';
import { Button } from '@/components/ui/button';
import { Popover, PopoverClose, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';

/** Agent-owned topology and eligibility; no protocol IDs or fixed slot counts in the UI. */
export function MaterialSourcePicker({ material, sources, value, disabled, onChange }: {
  material: PrintMaterialRequirement; sources: readonly PrintMaterialSource[]; value: string;
  disabled: boolean; onChange(pathId: string): void;
}) {
  const [open, setOpen] = useState(false);
  const selected = sources.find(source => source.pathId === value);
  const invalid = !!value && (!selected || selected.disabledReason !== null);
  const category = sources.find(source => source.unit.kind === 'automatic-feeder')?.unit.categoryLabel;
  const tools = [...new Map(sources.map(source => [source.tool.id, source.tool])).values()];
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const choose = (path: string) => { if (!disabled) { onChange(path); setOpen(false); } };
  return <Popover modal open={open && !disabled} onOpenChange={setOpen}>
    <PopoverTrigger disabled={disabled} aria-label={`Material ${material.index + 1} source`} aria-invalid={invalid || undefined} data-source={value}
      title={selected ? `${selected.label} · ${selected.materialType ?? 'Unknown material'}${selected.disabledReason ? ` · ${selected.disabledReason}` : ''}` : 'Select filament source'}
      className={`flex w-28 flex-col overflow-hidden rounded border bg-control-background text-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 ${invalid ? 'border-destructive' : 'border-border'}`} style={materialColor(selected?.color)}>
      <span className="w-full truncate px-2 py-1 text-center font-medium" style={materialColor(material.color)} data-testid={`slice-material-${material.index}`}>{material.type}</span>
      <span className="flex h-8 w-full items-center gap-1.5 px-1.5"><Disc3 className="size-4 shrink-0" aria-hidden="true" /><span className="min-w-0 flex-1 truncate">{invalid ? 'Unavailable' : selected?.slot.name ?? 'Select'}</span><ChevronDown className="size-3 shrink-0" /></span>
    </PopoverTrigger>
    <PopoverContent align="start" className="max-h-[min(480px,var(--available-height))] max-w-[calc(100vw-32px)] gap-0 overflow-y-auto p-0" style={{ width: tools.length > 1 ? 560 : 300 }}
      data-print-dialog-popover aria-label={`Material ${material.index + 1} sources`} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } }}>
      <div className="flex items-center justify-between gap-3 border-b bg-control-background/50 px-3 py-2">
        <PopoverTitle>{category ? `${category} Slots` : 'Filament Slots'}</PopoverTitle>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon" aria-label="Reset current filament mapping" title="Reset current filament mapping" onClick={() => choose('')}><Eraser className="size-4" /></Button>
          <PopoverClose render={<Button variant="ghost" size="icon" aria-label="Close filament sources" />}><X className="size-4" /></PopoverClose>
        </div>
      </div>
      <PopoverDescription className="px-3 pt-3">Select a source for {material.type}.</PopoverDescription>
      {invalid && <p role="status" className="px-3 pt-2 text-destructive">{selected?.disabledReason ?? 'Previous source unavailable. Choose another slot.'}</p>}
      {!sources.length && <p className="p-3 text-muted-foreground">No material sources reported by the printer.</p>}
      <div className={`grid gap-4 p-3 ${tools.length > 1 ? 'min-[560px]:grid-cols-2' : ''}`}>
        {tools.map(tool => {
          const toolSources = sources.filter(source => source.tool.id === tool.id);
          return <section key={tool.id} aria-label={tool.name} className="min-w-0 space-y-3">
            {tools.length > 1 && <h3 className="text-sm font-semibold">{tool.name}</h3>}
            {(['automatic-feeder', 'manual-holder'] as const).map(kind => {
              const units = [...new Map(toolSources.filter(source => source.unit.kind === kind).map(source => [source.unit.id, source.unit])).values()];
              return units.length > 0 && <div key={kind} className="space-y-2">
                <div className="flex items-center gap-2 text-muted-foreground"><span>{units[0].categoryLabel}</span><span className="h-px flex-1 bg-border" /></div>
                {units.map(unit => <div key={unit.id} role="group" aria-label={unit.name} className="rounded border px-2 py-2">
                  <div className="flex flex-wrap gap-2">
                    {toolSources.filter(source => source.unit.id === unit.id).map(source => <SourceSlot key={source.pathId} source={source} selected={source.pathId === value} onSelect={() => choose(source.pathId)} />)}
                  </div>
                  <p className="mt-2 text-[10px] text-muted-foreground">{unit.name}</p>
                </div>)}
              </div>;
            })}
          </section>;
        })}
      </div>
    </PopoverContent>
  </Popover>;
}

function SourceSlot({ source, selected, onSelect }: { source: PrintMaterialSource; selected: boolean; onSelect(): void }) {
  const unavailable = source.disabledReason !== null;
  const material = source.presence === 'empty' && source.unit.kind !== 'manual-holder' ? '—' : source.materialType ?? '?';
  return <button type="button" aria-label={`${source.label} · ${material}`} aria-pressed={selected} disabled={unavailable} aria-description={source.disabledReason ?? undefined}
    title={source.disabledReason ?? `${source.label} · ${source.materialType ?? 'Unknown material; type cannot be checked'}`}
    onClick={onSelect} className={`relative flex h-16 w-12 shrink-0 flex-col items-center justify-center gap-1 overflow-hidden rounded border text-xs outline-none focus-visible:ring-2 focus-visible:ring-primary ${selected ? 'border-primary ring-1 ring-primary' : 'border-border'} ${unavailable ? 'cursor-not-allowed bg-muted/20 text-muted-foreground opacity-45' : 'bg-control-background text-foreground hover:ring-1 hover:ring-primary'}`}
    style={unavailable ? undefined : materialColor(source.color)}>
    {source.remainingFraction !== null && <span className="absolute inset-x-1 top-1 h-1 overflow-hidden rounded bg-black/15" title={`${Math.round(source.remainingFraction * 100)}% remaining`}><span className="block h-full bg-current" style={{ width: `${source.remainingFraction * 100}%` }} /></span>}
    {selected && <Check className="absolute right-0.5 top-1.5 size-3.5" aria-hidden="true" />}
    <span className="mt-2 w-full truncate px-0.5 font-semibold">{source.slot.name}</span>
    <span className="w-full truncate px-0.5 text-[10px]">{material}</span>
  </button>;
}

function materialColor(value: string | null | undefined) {
  if (!value || !/^#[\da-f]{6}([\da-f]{2})?$/i.test(value)) return undefined;
  return { ...colorSwatchStyle({ mode: 'solid', colors: [value] }), color: colorSwatchForeground(value) };
}
