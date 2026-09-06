import { useMemo, useState } from 'react';
import type { PlateSessionSnapshot } from '@slicer/client';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { projectPreviewPlateList } from './previewPlateListProjection';

export function PreviewPlateList({
  snapshot,
  pending = false,
  onSelect,
}: {
  snapshot: PlateSessionSnapshot;
  pending?: boolean;
  onSelect: (plateId: string) => Promise<void> | void;
}) {
  const results = useSlicerStore((state) => state.plateResults);
  const [selecting, setSelecting] = useState<string | null>(null);
  const items = useMemo(() => projectPreviewPlateList(snapshot, results), [results, snapshot]);
  const disabled = pending || selecting !== null;

  async function handleSelect(plateId: string) {
    if (disabled) return;
    setSelecting(plateId);
    try {
      await onSelect(plateId);
    } finally {
      setSelecting(null);
    }
  }

  return (
    <section className="border-b px-2 py-2" aria-label="Preview plates" data-testid="preview-plate-list">
      <div className="mb-1 px-1 text-xs font-medium text-muted-foreground">Plates</div>
      <div role="listbox" aria-label="Preview plates" aria-activedescendant={`preview-plate-${snapshot.currentPlateId}`}>
        {items.map((item) => (
          <button
            key={item.plate.plateId}
            id={`preview-plate-${item.plate.plateId}`}
            type="button"
            role="option"
            aria-selected={item.current}
            aria-label={`${item.label}, ${item.detail}${item.current ? ', current plate' : ''}`}
            data-testid={`preview-plate-${item.plate.plateId}`}
            data-plate-status={item.status}
            disabled={disabled}
            onClick={() => void handleSelect(item.plate.plateId)}
            className={`mb-1 flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm transition-colors ${item.current ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'} disabled:cursor-default disabled:opacity-100`}
          >
            <span className="min-w-0 truncate">{item.label}</span>
            <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">{selecting === item.plate.plateId ? 'Loading…' : item.detail}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
