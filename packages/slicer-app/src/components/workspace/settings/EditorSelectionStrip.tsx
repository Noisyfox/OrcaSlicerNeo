import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { ConfigEditorChoice } from '@slicer/client';
import { NozzleIcon } from '@/components/ui/nozzle-icon';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { cn } from 'cn';

/** Shared presentation and scrolling for nozzle and variant selections. */
export function EditorSelectionStrip({ choices, choiceId, onSelect, disabled, label, testId, children, fitContent = false }: {
  choices: readonly ConfigEditorChoice[];
  choiceId: string | null;
  onSelect: (id: string | null) => void;
  disabled: boolean;
  label: string;
  testId: string;
  children: ReactNode;
  fitContent?: boolean;
}) {
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
  }, [choiceId, choices]);

  return <div className={cn('flex min-w-0 items-center gap-1 rounded-sm bg-control-background p-1', fitContent ? 'w-fit max-w-full' : 'w-full')} data-testid={testId}>
    <NozzleIcon className="size-4 shrink-0 text-muted-foreground" />
    <div ref={viewport} data-horizontal-scroll="" className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:thin]" data-testid={`${testId}-scroll`}>
      <ToggleGroup aria-label={label} variant="nozzle" size="nozzle" spacing={1} className={cn(!fitContent && 'min-w-full')}
        value={choiceId ? [choiceId] : []} disabled={disabled} onValueChange={values => { if (values[0]) onSelect(values[0]); }}
        onFocusCapture={event => reveal((event.target as HTMLElement).closest<HTMLElement>('[data-slot="toggle-group-item"]'))}>
        {children}
      </ToggleGroup>
    </div>
  </div>;
}
