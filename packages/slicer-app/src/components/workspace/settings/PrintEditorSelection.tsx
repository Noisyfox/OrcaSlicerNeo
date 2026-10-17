import { useLayoutEffect, useRef } from 'react';
import type { ConfigEditorChoice, ConfigEditorSelection } from '@slicer/client';
import { NozzleIcon } from '@/components/ui/nozzle-icon';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { cn } from 'cn';

// Native NozzleVolumeType labels, not vector-index or variant calculations.
export function printChoiceFlow(choice: ConfigEditorChoice): string {
  return ({ 0: 'SF', 1: 'HF', 2: 'Hybrid', 3: 'TPU HF', 5: 'E3D HF', 6: 'XHF' } as Record<number, string>)[choice.flowType ?? -1] ?? choice.variant;
}

export function PrintEditorSelection({ metadata, choiceId, onSelect, disabled, dirtyChoiceIds }: {
  dirtyChoiceIds: ReadonlySet<string>;
  metadata: ConfigEditorSelection;
  choiceId: string | null;
  onSelect: (id: string | null) => void;
  disabled: boolean;
}) {
  const diameters = useSettingsStore(state => state.values.nozzle_diameter)?.split(',').map(value => value.trim()) ?? [];
  const viewport = useRef<HTMLDivElement>(null);
  const reveal = (button: HTMLElement | null) => {
    const scroller = viewport.current;
    if (!scroller || !button) return;
    const outer = scroller.getBoundingClientRect();
    const inner = button.getBoundingClientRect();
    if (inner.left < outer.left) scroller.scrollLeft += inner.left - outer.left;
    else if (inner.right > outer.right) scroller.scrollLeft += inner.right - outer.right;
  };
  useLayoutEffect(() => {
    const keepSelectedVisible = () => reveal(viewport.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? null);
    keepSelectedVisible();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(keepSelectedVisible);
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [choiceId, metadata.choices]);

  return <div className="flex w-full min-w-0 items-center gap-1 rounded-sm bg-control-background p-1" data-testid="print-editor-selection">
    <NozzleIcon className="size-4 shrink-0 text-muted-foreground" />
    <div ref={viewport} data-horizontal-scroll="" className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:thin]" data-testid="print-editor-selection-scroll">
      <ToggleGroup aria-label="Print nozzle" variant="nozzle" size="nozzle" spacing={1} className="min-w-full"
        value={choiceId ? [choiceId] : []} disabled={disabled} onValueChange={values => { if (values[0]) onSelect(values[0]); }}
        onFocusCapture={event => reveal((event.target as HTMLElement).closest<HTMLElement>('[data-slot="toggle-group-item"]'))}>
        {metadata.choices.map(choice => {
          const diameter = choice.extruderIndex === null ? '—' : diameters[choice.extruderIndex] ?? diameters[0] ?? '—';
          const dirty = dirtyChoiceIds.has(choice.id);
          return <ToggleGroupItem key={choice.id} value={choice.id} aria-label={choice.label} title={`${choice.label}: ${diameter} mm ${printChoiceFlow(choice)}`}
            data-choice-id={choice.id} data-dirty={dirty ? 'true' : 'false'}>
            <span className="flex flex-col items-center">
              <span className={cn(dirty ? 'text-config-override' : 'text-foreground')}>{choice.extruderIndex === null ? '—' : choice.extruderIndex + 1}</span>
              <span className={cn(dirty ? 'text-config-override' : 'text-muted-foreground')}>{diameter} {printChoiceFlow(choice)}</span>
            </span>
          </ToggleGroupItem>;
        })}
      </ToggleGroup>
    </div>
  </div>;
}
