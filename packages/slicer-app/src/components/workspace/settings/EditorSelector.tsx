import { useLayoutEffect, useRef } from 'react';
import { NozzleIcon } from '@/components/ui/nozzle-icon';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from 'cn';

export interface EditorSelectorItem {
  readonly id: string;
  readonly label: string;
  readonly primary: string | number;
  readonly secondary?: string;
  readonly title?: string;
  readonly testId?: string;
}

interface EditorSelectorBaseProps {
  disabled: boolean;
  label: string;
  testId: string;
}

interface FlatSelectorProps extends EditorSelectorBaseProps {
  mode: 'flat';
  items: readonly EditorSelectorItem[];
  choiceId: string | null;
  onSelect: (id: string) => void;
  dirtyChoiceIds: ReadonlySet<string>;
  width?: 'content' | 'full';
}

export interface EditorSelectorNozzle {
  readonly id: string;
  readonly label: string;
  readonly primary: string | number;
  readonly secondary: string;
  readonly testId?: string;
  readonly flowLabel: string;
  readonly flowTestId?: string;
  readonly choiceId: string | null;
  readonly choices: readonly { readonly id: string; readonly label: string; readonly testId?: string }[];
}

interface NozzleSelectorProps extends EditorSelectorBaseProps {
  mode: 'nozzles';
  nozzles: readonly EditorSelectorNozzle[];
  nozzleId: string | null;
  onSelectNozzle: (id: string) => void;
  onSelectChoice: (id: string) => void;
}

/** Controlled presentation only; native mapping and selection lifetime belong to callers. */
export function EditorSelector(props: FlatSelectorProps | NozzleSelectorProps) {
  return props.mode === 'flat' ? <FlatEditorSelector {...props} /> : <NozzleEditorSelector {...props} />;
}

function FlatEditorSelector({ items, choiceId, onSelect, disabled, label, testId, dirtyChoiceIds, width = 'content' }: FlatSelectorProps) {
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
  }, [choiceId, items]);

  return <div className={cn('flex min-w-0 items-center gap-1 rounded-sm bg-control-background p-1', width === 'content' ? 'w-fit max-w-full' : 'w-full')} data-testid={testId}>
    <NozzleIcon className="size-4 shrink-0 text-muted-foreground" />
    <div ref={viewport} data-horizontal-scroll="" className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:thin]" data-testid={`${testId}-scroll`}>
      <ToggleGroup aria-label={label} variant="nozzle" size="nozzle" spacing={1} className={cn(width === 'full' && 'min-w-full')}
        value={choiceId ? [choiceId] : []} disabled={disabled} onValueChange={values => { if (values[0]) onSelect(values[0]); }}
        onFocusCapture={event => reveal((event.target as HTMLElement).closest<HTMLElement>('[data-slot="toggle-group-item"]'))}>
        {items.map(item => {
          const dirty = dirtyChoiceIds.has(item.id);
          const primary = <span className={cn(dirty ? 'text-config-override' : item.secondary !== undefined && 'text-foreground')}>{item.primary}</span>;
          return <ToggleGroupItem key={item.id} value={item.id} aria-label={item.label} title={item.title ?? item.label}
            data-choice-id={item.id} data-testid={item.testId} data-dirty={dirty ? 'true' : 'false'}>
            {item.secondary === undefined ? primary : <span className="flex flex-col items-center">
              {primary}
              <span className={cn(dirty ? 'text-config-override' : 'text-muted-foreground')}>{item.secondary}</span>
            </span>}
          </ToggleGroupItem>;
        })}
      </ToggleGroup>
    </div>
  </div>;
}

function NozzleEditorSelector({ nozzles, nozzleId, onSelectNozzle, onSelectChoice, disabled, label, testId }: NozzleSelectorProps) {
  return <div className="printer-toolhead-list w-max max-w-full flex-wrap" role="group" aria-label={label} data-testid={testId}>
    {nozzles.map(nozzle => {
      const selected = nozzle.id === nozzleId;
      const flow = nozzle.choices.find(choice => choice.id === nozzle.choiceId);
      return <div key={nozzle.id} className="printer-nozzle-extruder printer-toolhead preset-editor-toolhead" data-active={selected}>
        <Button type="button" variant="ghost" className="h-7 w-full flex-col gap-0 rounded-none border-0 p-0 text-[13px] leading-[14px] font-normal"
          aria-pressed={selected} aria-label={nozzle.label} data-testid={nozzle.testId} disabled={disabled}
          onClick={() => onSelectNozzle(nozzle.id)}>
          <span>{nozzle.primary}</span><span>{nozzle.secondary}</span>
        </Button>
        <Select value={flow?.id ?? null} disabled={disabled || nozzle.choices.length === 0}
          items={nozzle.choices.map(choice => ({ value: choice.id, label: choice.label }))}
          onValueChange={id => { if (id !== null && nozzle.choices.some(choice => choice.id === id)) onSelectChoice(id); }}>
          <SelectTrigger variant="sidebar" className="preset-editor-nozzle-flow" aria-label={nozzle.flowLabel} data-testid={nozzle.flowTestId}>
            <SelectValue>{flow?.label ?? 'Unavailable'}</SelectValue>
          </SelectTrigger>
          <SelectContent><SelectGroup>{nozzle.choices.map(choice => <SelectItem key={choice.id} value={choice.id}
            data-testid={choice.testId}>{choice.label}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
      </div>;
    })}
  </div>;
}
