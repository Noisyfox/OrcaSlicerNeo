// packages/slicer-app/src/components/viewport/LayerScrubber.tsx
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import type { ToolpathGeometry } from './useSliceResult';

function maxLayerOf(data: ToolpathGeometry): number {
  let max = 0;
  for (let i = 0; i < data.segmentCount; i++) max = Math.max(max, data.layerIds[i] ?? 0);
  return max;
}

/** Orca-style canvas overlay for the Phase-B preview controls. */
export function LayerScrubber({ data }: { data: ToolpathGeometry }) {
  const maxLayer = maxLayerOf(data);
  const preview = useSlicerStore((s) => s.preview);
  const setLayerRange = useSlicerStore((s) => s.setPreviewLayerRange);
  const setMoveRange = useSlicerStore((s) => s.setPreviewMoveRange);
  const setShowTravel = useSlicerStore((s) => s.setPreviewShowTravel);
  const setDimPreviousLayers = useSlicerStore((s) => s.setPreviewDimPreviousLayers);
  const setSingleLayer = useSlicerStore((s) => s.setPreviewSingleLayer);
  const toggleFeature = useSlicerStore((s) => s.setPreviewFeatureVisibility);

  const palette = useMemo(() => data.features.length
    ? data.features.reduce<number[]>((ids, id) => ids.includes(id) ? ids : [...ids, id], [])
    : [], [data.features]);
  const activeLayer = Math.max(0, Math.min(maxLayer, preview.visibleLayerEnd));
  let maxMove = 0;
  for (let i = 0; i < data.segmentCount; i++) {
    if (data.layerIds[i] === activeLayer) maxMove = Math.max(maxMove, data.moveOrders[i] ?? 0);
  }
  const layerStart = Math.max(0, Math.min(maxLayer, preview.visibleLayerStart));
  const layerEnd = Math.max(layerStart, Math.min(maxLayer, preview.visibleLayerEnd));
  const moveStart = Math.max(0, Math.min(maxMove, preview.activeMoveStart));
  const moveEnd = Math.max(moveStart, Math.min(maxMove, preview.activeMoveEnd));

  return (
    <>
      <aside data-testid="preview-controls" aria-label="G-code preview controls" className="pointer-events-auto absolute right-3 top-3 z-20 flex max-h-[calc(100%-6rem)] w-52 flex-col gap-3 overflow-auto rounded-md border bg-card/90 p-3 text-card-foreground shadow-lg backdrop-blur">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-semibold">Preview</Label>
          <Button variant="ghost" size="xs" aria-pressed={preview.singleLayer} data-testid="preview-single-layer" onClick={() => setSingleLayer(!preview.singleLayer)}>
            {preview.singleLayer ? 'All layers' : 'Single layer'}
          </Button>
        </div>
        <div data-testid="preview-legend" className="space-y-1">
          <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">Feature / Line Type</div>
          {palette.map((id) => {
            const entry = data.palette[id];
            const enabled = preview.featureVisibility[id] !== false;
            return (
              <button key={id} type="button" aria-pressed={enabled} data-testid={`preview-feature-visibility-${id}`} onClick={() => toggleFeature(id, !enabled)} className={`flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs ${enabled ? '' : 'opacity-40 line-through'}`}>
                <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: entry?.color ? `rgb(${entry.color.join(',')})` : '#94a3b8' }} />
                <span>{entry?.name ?? `Feature ${id}`}</span>
              </button>
            );
          })}
          {palette.length === 0 && <div className="text-xs text-muted-foreground">No feature data</div>}
        </div>
        <Button variant={preview.showTravel ? 'secondary' : 'outline'} size="sm" aria-pressed={preview.showTravel} data-testid="preview-travel-toggle" onClick={() => setShowTravel(!preview.showTravel)}>{preview.showTravel ? 'Hide travel' : 'Show travel'}</Button>
        <Button variant={preview.dimPreviousLayers ? 'secondary' : 'outline'} size="sm" aria-pressed={preview.dimPreviousLayers} data-testid="preview-dimming-toggle" onClick={() => setDimPreviousLayers(!preview.dimPreviousLayers)}>{preview.dimPreviousLayers ? 'Dim previous layers' : 'Show layers equally'}</Button>
      </aside>
      <div data-testid="preview-layer-range" className="pointer-events-auto absolute right-2 top-1/2 z-10 h-2/5 min-h-36 rounded-md border bg-card/85 p-2 shadow-lg backdrop-blur">
        <Label className="sr-only">Visible layer range</Label>
        <div data-testid="layer-scrubber" className="relative h-full w-6">
          <Slider orientation="vertical" min={0} max={maxLayer} step={1} value={[layerStart]} onValueChange={(value) => { const values = Array.isArray(value) ? value : [value]; setLayerRange([values[0] ?? 0, layerEnd]); }} aria-label="Visible layer range start" />
        </div>
        <div className="pointer-events-none absolute inset-2 [&_[data-slot=slider-thumb]]:pointer-events-auto">
          <Slider orientation="vertical" min={0} max={maxLayer} step={1} value={[layerEnd]} onValueChange={(value) => { const values = Array.isArray(value) ? value : [value]; setLayerRange([layerStart, values[0] ?? layerEnd]); }} aria-label="Visible layer range end" />
        </div>
        <span className="sr-only">Layers {layerStart + 1} through {layerEnd + 1}</span>
      </div>
      <div data-testid="preview-move-range" className="pointer-events-auto absolute bottom-3 left-1/2 z-10 w-2/5 min-w-48 -translate-x-1/2 rounded-md border bg-card/85 p-2 shadow-lg backdrop-blur">
        <div className="mb-1 flex justify-between text-[0.65rem] text-muted-foreground"><span>Move</span><span>{moveEnd + 1} / {maxMove + 1}</span></div>
        <Slider min={0} max={maxMove} step={1} value={[moveStart, moveEnd]} onValueChange={(value) => { const values = Array.isArray(value) ? value : [value]; setMoveRange([values[0] ?? 0, values.at(-1) ?? values[0] ?? 0]); }} aria-label="Active layer move range" />
      </div>
    </>
  );
}
