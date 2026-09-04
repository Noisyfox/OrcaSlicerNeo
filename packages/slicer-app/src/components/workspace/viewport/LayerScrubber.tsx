// packages/slicer-app/src/components/viewport/LayerScrubber.tsx
import { useEffect, useMemo, useRef, useState, type WheelEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDownIcon } from 'lucide-react';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import type { ToolpathGeometry } from './useSliceResult';
import { maxMoveOrderForLayer, nextRenderablePreviewLayer, renderablePreviewLayers } from './previewSemantics';
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
  const [previewExpanded, setPreviewExpanded] = useState(true);
  const renderableLayers = useMemo(() => renderablePreviewLayers(data), [data]);
  const maxLayer = renderableLayers[renderableLayers.length - 1] ?? 0;
  const preview = useSlicerStore((s) => s.preview);
  const setLayerRange = useSlicerStore((s) => s.setPreviewLayerRange);
  const setLayerEnd = useSlicerStore((s) => s.setPreviewLayerEnd);
  const setMoveEnd = useSlicerStore((s) => s.setPreviewMoveEnd);
  const setShowTravel = useSlicerStore((s) => s.setPreviewShowTravel);
  const setDimPreviousLayers = useSlicerStore((s) => s.setPreviewDimPreviousLayers);
  const setSingleLayer = useSlicerStore((s) => s.setPreviewSingleLayer);
  const setColorScheme = useSlicerStore((s) => s.setPreviewColorScheme);
  const setSchemeVisibility = useSlicerStore((s) => s.setPreviewSchemeVisibility);
  const layerRangeFrameRef = useRef<HTMLDivElement>(null);
  const moveSurfaceRef = useRef<HTMLDivElement>(null);
  const moveRangeFrameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const surfaces = [
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
    const nextEnd = nextRenderablePreviewLayer(renderableLayers, layerEnd, step);
    const nextMaxMove = maxMoveOrderForLayer(data, nextEnd);
    if (preview.singleLayer) setLayerEnd(nextEnd, nextMaxMove);
    else setLayerRange([layerStart, nextEnd], nextMaxMove);
  };

  return (
    <>
      <Collapsible
        open={previewExpanded}
        onOpenChange={setPreviewExpanded}
        data-testid="preview-controls"
        aria-label="G-code preview controls"
        className="pointer-events-auto absolute right-20 top-3 z-20 flex max-h-[calc(100%-6rem)] min-h-0 w-52 flex-col overflow-hidden rounded-md border bg-card/90 p-3 text-card-foreground shadow-lg backdrop-blur"
      >
        <CollapsibleTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              data-testid="preview-controls-header"
              className="h-7 w-full shrink-0 justify-between rounded px-1 py-1 text-left text-xs font-semibold"
            />
          }
        >
          <span>Preview</span>
          <ChevronDownIcon className="size-3 transition-transform group-aria-expanded/button:rotate-0 group-not-aria-expanded/button:-rotate-90" aria-hidden="true" />
        </CollapsibleTrigger>
        <CollapsibleContent id="preview-controls-content" className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          <Button variant="ghost" size="xs" aria-pressed={preview.singleLayer} data-testid="preview-single-layer" onClick={() => setSingleLayer(!preview.singleLayer)}>
            {preview.singleLayer ? 'All layers' : 'Single layer'}
          </Button>
          <div className="space-y-1 text-xs">
            <span className="sr-only">Color scheme</span>
            <Select value={activeScheme} items={schemes.map((scheme) => ({ value: scheme, label: PREVIEW_SCHEME_LABELS[scheme] }))} onValueChange={(value) => setColorScheme(value as PreviewColorScheme)}>
              <SelectTrigger id="preview-color-scheme" aria-label="Preview color scheme" data-testid="preview-color-scheme" className="h-7 w-full bg-background px-2 py-1 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {schemes.map((scheme) => <SelectItem key={scheme} value={scheme} data-testid={`preview-color-scheme-${scheme}`}>{PREVIEW_SCHEME_LABELS[scheme]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div data-testid="preview-legend" className="space-y-1">
            <div data-testid="preview-legend-header" className="px-1 py-1 text-[0.65rem] uppercase tracking-wide text-muted-foreground">
              {descriptor?.label ?? PREVIEW_SCHEME_LABELS[activeScheme]}
            </div>
            <div id="preview-legend-content">
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
          </div>
          <PreviewInspectionPanel data={data} />
          <Button variant={preview.showTravel ? 'secondary' : 'outline'} size="sm" aria-pressed={preview.showTravel} data-testid="preview-travel-toggle" onClick={() => setShowTravel(!preview.showTravel)}>{preview.showTravel ? 'Hide travel' : 'Show travel'}</Button>
          <Button variant={preview.dimPreviousLayers ? 'secondary' : 'outline'} size="sm" aria-pressed={preview.dimPreviousLayers} data-testid="preview-dimming-toggle" onClick={() => setDimPreviousLayers(!preview.dimPreviousLayers)}>{preview.dimPreviousLayers ? 'Dim previous layers' : 'Show layers equally'}</Button>
        </CollapsibleContent>
      </Collapsible>
      <div ref={layerRangeFrameRef} data-testid="preview-layer-range" onWheel={(event) => { const step = previewWheelStep(event); if (!step) return; adjustLayerEndWithWheel(step); }} className="pointer-events-auto absolute right-2 top-1/2 z-30 h-2/5 min-h-36 rounded-md border bg-card/85 p-2 shadow-lg backdrop-blur">
        <Label className="sr-only">Visible layer range</Label>
        <div data-testid="layer-scrubber" className="relative h-full w-6">
          <Slider orientation="vertical" min={0} max={maxLayer} step={1} value={[layerStart, layerEnd]} onValueChange={(value) => {
            const values = Array.isArray(value) ? value : [value];
            const nextStart = values[0] ?? layerStart;
            const nextEnd = values[1] ?? layerEnd;
            setLayerRange([nextStart, nextEnd], maxMoveOrderForLayer(data, nextEnd));
          }} onWheel={(event) => { const step = previewWheelStep(event); if (!step) return; adjustLayerEndWithWheel(step); }} aria-label="Visible layer range" />
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
