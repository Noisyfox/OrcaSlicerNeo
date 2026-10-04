import { memo, useEffect, useMemo, useRef, type WheelEvent } from 'react';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Layers, Menu } from 'lucide-react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem } from '@/components/ui/dropdown-menu';
import { Slider } from '@/components/ui/slider';
import { useSlicerStore } from '@/stores/useSlicerStore';
import type { ToolpathGeometry } from './useSliceResult';
import { maxMoveOrderForLayer, nextRenderablePreviewLayer, renderablePreviewLayers } from './previewSemantics';

function previewWheelStep(event: WheelEvent): number {
  if (event.deltaY === 0) return 0;
  event.preventDefault();
  event.stopPropagation();
  return event.deltaY < 0 ? 1 : -1;
}

/** Layer and move range overlays; display filters live in PreviewSidebar. */
export const LayerScrubber = memo(function LayerScrubber({ data }: { data: ToolpathGeometry }) {
  const renderableLayers = useMemo(() => renderablePreviewLayers(data), [data]);
  const maxLayer = renderableLayers[renderableLayers.length - 1] ?? 0;
  const preview = useSlicerStore((s) => s.preview);
  const setLayerRange = useSlicerStore((s) => s.setPreviewLayerRange);
  const setLayerEnd = useSlicerStore((s) => s.setPreviewLayerEnd);
  const setMoveEnd = useSlicerStore((s) => s.setPreviewMoveEnd);
  const setSingleLayer = useSlicerStore((s) => s.setPreviewSingleLayer);
  const setDimPreviousLayers = useSlicerStore((s) => s.setPreviewDimPreviousLayers);
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

  const activeLayer = Math.max(0, Math.min(maxLayer, preview.visibleLayerEnd));
  const maxMove = useMemo(() => maxMoveOrderForLayer(data, activeLayer), [activeLayer, data]);
  const layerStart = Math.max(0, Math.min(maxLayer, preview.visibleLayerStart));
  const layerEnd = Math.max(layerStart, Math.min(maxLayer, preview.visibleLayerEnd));
  const moveEnd = Math.max(0, Math.min(maxMove, preview.activeMoveEnd));
  const layerLabel = (layer: number) => {
    const z = data.metadata?.layerRanges.find((entry) => entry.id === layer)?.z;
    return <><span>{layer + 1}</span>{z !== undefined && Number.isFinite(z) && <span>{z.toFixed(2)}</span>}</>;
  };
  const adjustLayerEndWithWheel = (step: number) => {
    const nextEnd = nextRenderablePreviewLayer(renderableLayers, layerEnd, step);
    const nextMaxMove = maxMoveOrderForLayer(data, nextEnd);
    if (preview.singleLayer) setLayerEnd(nextEnd, nextMaxMove);
    else setLayerRange([layerStart, nextEnd], nextMaxMove);
  };

  return (
    <>
      <div ref={layerRangeFrameRef} data-testid="preview-layer-range" onWheel={(event) => { const step = previewWheelStep(event); if (!step) return; adjustLayerEndWithWheel(step); }} className="pointer-events-auto absolute left-0 top-[15%] z-30 h-[54%] min-h-40 w-6 rounded-full bg-card px-[9px] py-3">
        <Label className="sr-only">Visible layer range</Label>
        <div data-testid="layer-scrubber" className="relative h-full w-1.5">
          <Slider variant="preview" orientation="vertical" min={0} max={maxLayer} step={1} value={[layerStart, layerEnd]} thumbLabels={[preview.singleLayer ? null : layerLabel(layerStart), layerLabel(layerEnd)]} thumbTestIds={['layer-scrubber-start', 'layer-scrubber-end']} onValueChange={(value) => {
            const values = Array.isArray(value) ? value : [value];
            const nextStart = values[0] ?? layerStart;
            const nextEnd = values[1] ?? layerEnd;
            setLayerRange([nextStart, nextEnd], maxMoveOrderForLayer(data, nextEnd));
          }} onWheel={(event) => { const step = previewWheelStep(event); if (!step) return; adjustLayerEndWithWheel(step); }} aria-label="Visible layer range" />
        </div>
        <span className="sr-only">Layers {layerStart + 1} through {layerEnd + 1}</span>
        <Button
          variant="ghost"
          size="icon"
          data-testid="preview-single-layer"
          aria-pressed={!preview.singleLayer}
          aria-label="Multiple layers"
          title={preview.singleLayer ? 'Show all layers' : 'Show single layer'}
          onClick={() => setSingleLayer(!preview.singleLayer)}
          className="absolute left-0 top-[calc(100%+6px)] size-6 rounded-[3px] bg-card p-1 text-muted-foreground hover:bg-button-hover aria-pressed:text-primary-hover"
        >
          <Layers data-icon="inline-start" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button
            variant="ghost"
            size="icon"
            aria-label="Preview layer options"
            title="Preview layer options"
            data-testid="preview-layer-options"
            className="absolute left-0 top-[calc(100%+36px)] size-6 rounded-[3px] bg-card p-1 text-muted-foreground hover:bg-button-hover"
          />}>
            <Menu data-icon="inline-start" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start">
            <DropdownMenuCheckboxItem
              checked={preview.dimPreviousLayers}
              onCheckedChange={(checked) => setDimPreviousLayers(checked)}
              data-testid="preview-dimming-toggle"
            >
              Dim previous layers
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div ref={moveRangeFrameRef} data-testid="preview-move-range" onWheel={(event) => { const step = previewWheelStep(event); if (!step) return; setMoveEnd(moveEnd + step); }} className="pointer-events-auto absolute bottom-2 left-1/2 z-10 h-6 w-3/5 min-w-48 -translate-x-1/2 rounded-full bg-card px-3 py-[9px]">
        <div ref={moveSurfaceRef}>
          <Slider variant="preview" min={0} max={maxMove} step={1} value={[moveEnd]} thumbLabels={[moveEnd + 1]} onValueChange={(value) => { const values = Array.isArray(value) ? value : [value]; setMoveEnd(values[0] ?? 0); }} onWheel={(event) => { const step = previewWheelStep(event); if (!step) return; setMoveEnd(moveEnd + step); }} aria-label="Active layer move end" />
        </div>
      </div>
    </>
  );
});
