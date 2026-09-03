// packages/slicer-app/src/components/viewport/LayerScrubber.tsx
import { useEffect, useMemo, useRef, type WheelEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import type { ToolpathGeometry } from './useSliceResult';
import { maxMoveOrderForLayer, maxPreviewLayer } from './previewSemantics';
import {
  describePreviewScheme,
  PREVIEW_SCHEME_LABELS,
  previewSchemeAvailable,
  formatPreviewValue,
  type PreviewColorSource,
} from './toolpathColors';
import type { PreviewColorScheme } from '../../../stores/useSlicerStore';
import { PreviewInspectionPanel } from './PreviewInspectionPanel';

function previewWheelStep(event: WheelEvent): number {
  if (event.deltaY === 0) return 0;
  event.preventDefault();
  event.stopPropagation();
  return event.deltaY < 0 ? 1 : -1;
}

/** Orca-style canvas overlay for the Phase-B preview controls. */
export function LayerScrubber({ data }: { data: ToolpathGeometry }) {
  const maxLayer = maxPreviewLayer(data);
  const preview = useSlicerStore((s) => s.preview);
  const setLayerRange = useSlicerStore((s) => s.setPreviewLayerRange);
  const setLayerEnd = useSlicerStore((s) => s.setPreviewLayerEnd);
  const setMoveEnd = useSlicerStore((s) => s.setPreviewMoveEnd);
  const setShowTravel = useSlicerStore((s) => s.setPreviewShowTravel);
  const setDimPreviousLayers = useSlicerStore((s) => s.setPreviewDimPreviousLayers);
  const setSingleLayer = useSlicerStore((s) => s.setPreviewSingleLayer);
  const setColorScheme = useSlicerStore((s) => s.setPreviewColorScheme);
  const setSchemeVisibility = useSlicerStore((s) => s.setPreviewSchemeVisibility);
  const layerStartSurfaceRef = useRef<HTMLDivElement>(null);
  const layerEndSurfaceRef = useRef<HTMLDivElement>(null);
  const layerRangeFrameRef = useRef<HTMLDivElement>(null);
  const moveSurfaceRef = useRef<HTMLDivElement>(null);
  const moveRangeFrameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const surfaces = [
      layerStartSurfaceRef.current,
      layerEndSurfaceRef.current,
      layerRangeFrameRef.current,
      moveSurfaceRef.current,
      moveRangeFrameRef.current,
    ]
      .filter((surface): surface is HTMLDivElement => surface !== null);
    const preventNativeWheel = (event: globalThis.WheelEvent) => {
      if (event.deltaY !== 0) event.preventDefault();
    };
    surfaces.forEach((surface) => surface.addEventListener('wheel', preventNativeWheel, { passive: false }));
    return () => surfaces.forEach((surface) => surface.removeEventListener('wheel', preventNativeWheel));
  }, []);

  const colorSource = useMemo<PreviewColorSource>(() => ({
    palette: data.palette,
    features: data.features,
    moveTypes: data.moveTypes,
    extruderIds: data.extruderIds,
    metrics: data.metrics,
    layerIds: data.layerIds,
    ...(data.extruderPalette ? { extruderPalette: data.extruderPalette } : {}),
    ...(data.analysis ? { analysis: data.analysis } : {}),
  }), [data.analysis, data.extruderIds, data.extruderPalette, data.features, data.layerIds, data.metrics, data.moveTypes, data.palette]);
  const schemes = (Object.keys(PREVIEW_SCHEME_LABELS) as PreviewColorScheme[])
    .filter((scheme) => previewSchemeAvailable(colorSource, scheme));
  const activeScheme = schemes.includes(preview.colorScheme) ? preview.colorScheme : 'feature';
  const descriptor = describePreviewScheme(colorSource, activeScheme);
  const visibility = preview.schemeVisibility[activeScheme] ?? {};
  const activeLayer = Math.max(0, Math.min(maxLayer, preview.visibleLayerEnd));
  const maxMove = maxMoveOrderForLayer(data, activeLayer);
  const layerStart = Math.max(0, Math.min(maxLayer, preview.visibleLayerStart));
  const layerEnd = Math.max(layerStart, Math.min(maxLayer, preview.visibleLayerEnd));
  const moveEnd = Math.max(0, Math.min(maxMove, preview.activeMoveEnd));
  const adjustLayerEndWithWheel = (step: number) => {
    const nextEnd = layerEnd + step;
    const nextMaxMove = maxMoveOrderForLayer(data, nextEnd);
    if (preview.singleLayer) setLayerEnd(nextEnd, nextMaxMove);
    else setLayerRange([layerStart, nextEnd], nextMaxMove);
  };

  return (
    <>
      <aside data-testid="preview-controls" aria-label="G-code preview controls" className="pointer-events-auto absolute right-20 top-3 z-20 flex max-h-[calc(100%-6rem)] w-52 flex-col gap-3 overflow-auto rounded-md border bg-card/90 p-3 text-card-foreground shadow-lg backdrop-blur">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-semibold">Preview</Label>
          <Button variant="ghost" size="xs" aria-pressed={preview.singleLayer} data-testid="preview-single-layer" onClick={() => setSingleLayer(!preview.singleLayer)}>
            {preview.singleLayer ? 'All layers' : 'Single layer'}
          </Button>
        </div>
        <label className="space-y-1 text-xs">
          <span className="sr-only">Color scheme</span>
          <select aria-label="Preview color scheme" data-testid="preview-color-scheme" value={activeScheme} onChange={(event) => setColorScheme(event.target.value as PreviewColorScheme)} className="w-full rounded border bg-background px-2 py-1 text-xs">
            {schemes.map((scheme) => <option key={scheme} value={scheme}>{PREVIEW_SCHEME_LABELS[scheme]}</option>)}
          </select>
        </label>
        <div data-testid="preview-legend" className="space-y-1">
          <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">{descriptor?.label ?? PREVIEW_SCHEME_LABELS[activeScheme]}</div>
          {descriptor?.kind === 'categorical' && descriptor.items.map((item) => {
            const enabled = visibility[item.id] !== false;
            return (
              <button key={item.id} type="button" aria-pressed={enabled} data-testid={activeScheme === 'feature' ? `preview-feature-visibility-${item.id}` : `preview-scheme-visibility-${activeScheme}-${item.id}`} onClick={() => setSchemeVisibility(activeScheme, item.id, !enabled)} className={`flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs ${enabled ? '' : 'opacity-40 line-through'}`}>
                <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: `rgb(${item.color.map((value) => Math.round(value * 255)).join(',')})` }} />
                <span>{item.label}</span>
              </button>
            );
          })}
          {descriptor?.kind === 'numeric' && <>
            <div className="h-2 rounded-sm" style={{ background: `linear-gradient(to right, ${descriptor.items.map((item) => `rgb(${item.color.map((value) => Math.round(value * 255)).join(',')})`).join(', ')})` }} />
            <div className="flex justify-between text-[0.65rem] text-muted-foreground"><span>{formatPreviewValue(descriptor.min ?? 0, descriptor.unit)}</span><span>{formatPreviewValue(descriptor.max ?? 0, descriptor.unit)}</span></div>
          </>}
          {!descriptor && <div className="text-xs text-muted-foreground">No data for this scheme</div>}
        </div>
        <PreviewInspectionPanel data={data} />
        <Button variant={preview.showTravel ? 'secondary' : 'outline'} size="sm" aria-pressed={preview.showTravel} data-testid="preview-travel-toggle" onClick={() => setShowTravel(!preview.showTravel)}>{preview.showTravel ? 'Hide travel' : 'Show travel'}</Button>
        <Button variant={preview.dimPreviousLayers ? 'secondary' : 'outline'} size="sm" aria-pressed={preview.dimPreviousLayers} data-testid="preview-dimming-toggle" onClick={() => setDimPreviousLayers(!preview.dimPreviousLayers)}>{preview.dimPreviousLayers ? 'Dim previous layers' : 'Show layers equally'}</Button>
      </aside>
      <div ref={layerRangeFrameRef} data-testid="preview-layer-range" onWheel={(event) => { const step = previewWheelStep(event); if (!step) return; adjustLayerEndWithWheel(step); }} className="pointer-events-auto absolute right-2 top-1/2 z-30 h-2/5 min-h-36 rounded-md border bg-card/85 p-2 shadow-lg backdrop-blur">
        <Label className="sr-only">Visible layer range</Label>
        <div ref={layerStartSurfaceRef} data-testid="layer-scrubber" className="relative h-full w-6">
          <Slider orientation="vertical" min={0} max={maxLayer} step={1} value={[layerStart]} onValueChange={(value) => { const values = Array.isArray(value) ? value : [value]; const nextStart = values[0] ?? layerStart; if (preview.singleLayer) setLayerEnd(nextStart, maxMoveOrderForLayer(data, nextStart)); else setLayerRange([nextStart, layerEnd], maxMove); }} onWheel={(event) => { const step = previewWheelStep(event); if (!step) return; adjustLayerEndWithWheel(step); }} aria-label="Visible layer range start" />
        </div>
        <div ref={layerEndSurfaceRef} className="pointer-events-none absolute inset-2 [&_[data-slot=slider-thumb]]:pointer-events-auto">
          <Slider orientation="vertical" min={0} max={maxLayer} step={1} value={[layerEnd]} onValueChange={(value) => { const values = Array.isArray(value) ? value : [value]; const nextEnd = values[0] ?? layerEnd; const nextMaxMove = maxMoveOrderForLayer(data, nextEnd); if (preview.singleLayer) setLayerEnd(nextEnd, nextMaxMove); else setLayerRange([layerStart, nextEnd], nextMaxMove); }} onWheel={(event) => { const step = previewWheelStep(event); if (!step) return; adjustLayerEndWithWheel(step); }} aria-label="Visible layer range end" />
        </div>
        <span className="sr-only">Layers {layerStart + 1} through {layerEnd + 1}</span>
      </div>
      <div ref={moveRangeFrameRef} data-testid="preview-move-range" onWheel={(event) => { const step = previewWheelStep(event); if (!step) return; setMoveEnd(moveEnd + step); }} className="pointer-events-auto absolute bottom-3 left-1/2 z-10 w-2/5 min-w-48 -translate-x-1/2 rounded-md border bg-card/85 p-2 shadow-lg backdrop-blur">
        <div className="mb-1 flex justify-between text-[0.65rem] text-muted-foreground"><span>Move</span><span>{moveEnd + 1} / {maxMove + 1}</span></div>
        <div ref={moveSurfaceRef}>
          <Slider min={0} max={maxMove} step={1} value={[moveEnd]} onValueChange={(value) => { const values = Array.isArray(value) ? value : [value]; setMoveEnd(values[0] ?? 0); }} onWheel={(event) => { const step = previewWheelStep(event); if (!step) return; setMoveEnd(moveEnd + step); }} aria-label="Active layer move end" />
        </div>
      </div>
    </>
  );
}
