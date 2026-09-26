import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { buttonVariants } from '@/components/ui/button';
import { TooltipFor } from '@/components/ui/tooltip';
import {
  formatMemory,
  memoryTotalLabel,
  sampleMemoryIndicator,
  type MemoryIndicatorSample,
} from './memory';

const SAMPLE_INTERVAL_MS = 5_000;

type MemoryState =
  | { status: 'loading'; sample: MemoryIndicatorSample | null; error: null }
  | { status: 'available'; sample: MemoryIndicatorSample; error: null }
  | { status: 'unavailable'; sample: null; error: string };

export function MemoryIndicator() {
  const platform = usePlatform();
  const [state, setState] = useState<MemoryState>({ status: 'loading', sample: null, error: null });
  const sampling = useRef(false);

  const refresh = useCallback(async () => {
    if (sampling.current) return;
    sampling.current = true;
    try {
      const sample = await sampleMemoryIndicator(platform);
      setState({ status: 'available', sample, error: null });
    } catch (error) {
      setState({ status: 'unavailable', sample: null, error: String(error) });
    } finally {
      sampling.current = false;
    }
  }, [platform]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const label = state.status === 'available'
    ? `Memory: ${formatMemory(state.sample.totalBytes)}`
    : state.status === 'unavailable' ? 'Memory unavailable' : 'Memory…';

  return (
    <DropdownMenu onOpenChange={(open) => { if (open) void refresh(); }}>
      <DropdownMenuTrigger
        className={buttonVariants({ variant: 'ghost', size: 'xs', className: 'text-left' })}
        data-testid="memory-indicator"
      >
        {label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 p-3" data-testid="memory-indicator-popup">
        {state.status === 'available' ? <MemoryDetails sample={state.sample} /> : (
          <p className="text-xs text-muted-foreground" data-testid="memory-indicator-unavailable">
            {state.status === 'loading' ? 'Sampling memory…' : `Memory unavailable: ${state.error}`}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MemoryDetails({ sample }: { sample: MemoryIndicatorSample }) {
  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium">{memoryTotalLabel(sample.totalKind)}</span>
        <span data-testid="memory-indicator-total">{formatMemory(sample.totalBytes)}</span>
      </div>
      {sample.platform.entries.length > 0 && (
        <MemoryGroup title="Platform memory" entries={sample.platform.entries.map((entry) => ({ ...entry, note: null }))} />
      )}
      <MemoryGroup
        title="Shared runtime diagnostics"
        entries={sample.sharedRuntime.map((entry) => ({
          ...entry,
          note: entry.includedInTotal ? 'Included in total' : 'Diagnostic only',
        }))}
      />
    </div>
  );
}

function MemoryGroup({ title, entries }: {
  title: string;
  entries: readonly { id: string; label: string; bytes: number; note: string | null }[];
}) {
  return (
    <section className="space-y-1" aria-label={title}>
      <h3 className="font-medium text-muted-foreground">{title}</h3>
      {entries.map((entry) => (
        <div key={entry.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
          <TooltipFor content={entry.label}>
            <span className="min-w-0 truncate">{entry.label}</span>
          </TooltipFor>
          <span>{formatMemory(entry.bytes)}</span>
          {entry.note && <span className="col-span-2 text-muted-foreground">{entry.note}</span>}
        </div>
      ))}
    </section>
  );
}
