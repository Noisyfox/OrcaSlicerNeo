import { memo, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDownIcon, Eye, EyeOff, Clock3, Weight, Coins } from 'lucide-react';
import { useSlicerStore, type PreviewColorScheme } from '@/stores/useSlicerStore';
import type { ToolpathGeometry } from './useSliceResult';
import { PREVIEW_MOVE_OPTIONS, TRAVEL_MOVE_TYPE } from './previewMoveTypes';
import { describePreviewScheme, PREVIEW_SCHEME_LABELS, ORCA_TRAVEL_COLOR, previewSchemeAvailable, formatPreviewValue, type PreviewColorSource } from './toolpathColors';
import { PreviewInspectionPanel, formatPreviewTime } from './PreviewInspectionPanel';

/** Compact native slice totals, matching the reference's icon summary row. */
function PreviewStatisticsFooter({ data }: { data: ToolpathGeometry }) {
  const summary = data.analysis?.summary;
  const formatMetric = (value: number | undefined, suffix = '') =>
    value !== undefined && Number.isFinite(value) ? `${value.toFixed(2)}${suffix}` : '—';
  return <div data-testid="preview-statistics" className="space-y-2">
    <Separator />
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs tabular-nums">
      <span className="flex items-center gap-1" title="Estimated time" aria-label="Estimated time">
        <Clock3 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span data-testid="preview-summary-estimated-time">{formatPreviewTime(summary?.estimatedTimeSeconds)?.replaceAll(' ', '') ?? '—'}</span>
      </span>
      <span className="flex items-center gap-1" title="Filament length and weight" aria-label="Filament length and weight">
        <Weight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span><span data-testid="preview-summary-filament-length">{formatMetric(summary?.filamentLengthMeters, 'm')}</span> | <span data-testid="preview-summary-filament-weight">{formatMetric(summary?.filamentWeightGrams, 'g')}</span></span>
      </span>
      <span className="flex items-center gap-1" title="Filament cost" aria-label="Filament cost">
        <Coins className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span data-testid="preview-summary-filament-cost">{formatMetric(summary?.filamentCost)}</span>
      </span>
    </div>
  </div>;
}

/** Slice information and display filters live beside the viewport. */
export const PreviewSidebar = memo(function PreviewSidebar({ data }: { data: ToolpathGeometry }) {
  const [previewExpanded, setPreviewExpanded] = useState(true);
  const preview = useSlicerStore((s) => s.preview);
  const moveOptions = useMemo(() => {
    const present = new Set(data.moveTypes);
    return [
      { type: TRAVEL_MOVE_TYPE, label: 'Travel', color: ORCA_TRAVEL_COLOR.map((value) => Math.round(value * 255)) },
      ...PREVIEW_MOVE_OPTIONS,
    ].filter((option) => present.has(option.type));
  }, [data.moveTypes]);
  const setMoveVisibility = useSlicerStore((s) => s.setPreviewMoveVisibility);
  const setShowTravel = useSlicerStore((s) => s.setPreviewShowTravel);
  const setColorScheme = useSlicerStore((s) => s.setPreviewColorScheme);
  const setSchemeVisibility = useSlicerStore((s) => s.setPreviewSchemeVisibility);
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
  const schemes = useMemo(
    () => (Object.keys(PREVIEW_SCHEME_LABELS) as PreviewColorScheme[])
    .filter((scheme) => previewSchemeAvailable(colorSource, scheme)),
    [colorSource],
  );
  const activeScheme = schemes.includes(preview.colorScheme) ? preview.colorScheme : 'feature';
  const descriptor = useMemo(
    () => describePreviewScheme(colorSource, activeScheme),
    [activeScheme, colorSource],
  );
  const visibility = preview.schemeVisibility[activeScheme] ?? {};
  const featureStatistics = useMemo(() => new Map(data.analysis?.featureStatistics.map((entry) => [entry.featureId, entry])), [data.analysis]);
  const totalTime = data.analysis?.summary.estimatedTimeSeconds;
  return (
    <Collapsible
      open={previewExpanded}
      onOpenChange={setPreviewExpanded}
      data-testid="preview-controls"
      aria-label="G-code preview controls"
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-md bg-card text-card-foreground"
    >
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            data-testid="preview-controls-header"
            className="sidebar-section-header h-5! w-full shrink-0 rounded-none px-2 py-0 text-xs font-normal"
          />
        }
      >
        <span className="sidebar-section-title">Slice Info</span>
        <ChevronDownIcon className="absolute right-2 size-3 transition-transform group-aria-expanded/button:rotate-0 group-not-aria-expanded/button:-rotate-90" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent id="preview-controls-content" className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        <div className="space-y-1 text-xs">
          <span className="sr-only">Color scheme</span>
          <Select value={activeScheme} items={schemes.map((scheme) => ({ value: scheme, label: PREVIEW_SCHEME_LABELS[scheme] }))} onValueChange={(value) => setColorScheme(value as PreviewColorScheme)}>
            <SelectTrigger id="preview-color-scheme" aria-label="Preview color scheme" data-testid="preview-color-scheme" variant="sidebar" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {schemes.map((scheme) => <SelectItem key={scheme} value={scheme} data-testid={`preview-color-scheme-${scheme}`}>{PREVIEW_SCHEME_LABELS[scheme]}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div data-testid="preview-legend" className="space-y-1">
          <div data-testid="preview-legend-header" className="px-1 py-1 text-[0.65rem] uppercase tracking-wide text-muted-foreground">
            {activeScheme === 'feature' ? <div className="grid grid-cols-[minmax(0,1fr)_40px_24px_60px] gap-1"><span>Type</span><span className="text-right">Time</span><span className="text-right">%</span><span className="text-right">Usage</span></div> : descriptor?.label ?? PREVIEW_SCHEME_LABELS[activeScheme]}
          </div>
          <div id="preview-legend-content">
          {descriptor?.kind === 'categorical' && descriptor.items.map((item) => {
            const enabled = visibility[item.id] !== false;
            const statistics = activeScheme === 'feature' ? featureStatistics.get(item.id) : undefined;
            const time = statistics?.timeSeconds;
            const percentage = time !== undefined && Number.isFinite(time) && totalTime !== undefined && Number.isFinite(totalTime) && totalTime > 0
              ? (time / totalTime * 100).toFixed(1) : '—';
            const usage = [
              statistics?.filamentLengthMeters !== undefined && Number.isFinite(statistics.filamentLengthMeters) ? `${statistics.filamentLengthMeters.toFixed(2)}m` : undefined,
              statistics?.filamentWeightGrams !== undefined && Number.isFinite(statistics.filamentWeightGrams) ? `${statistics.filamentWeightGrams.toFixed(2)}g` : undefined,
            ].filter(Boolean).join(' ');
            return (
              <Button variant="ghost" size="xs" key={item.id} aria-pressed={enabled}
                data-testid={activeScheme === 'feature' ? `preview-feature-visibility-${item.id}` : `preview-scheme-visibility-${activeScheme}-${item.id}`}
                onClick={() => setSchemeVisibility(activeScheme, item.id, !enabled)}
                className={`sidebar-list-row grid w-full px-1 text-left ${activeScheme === 'feature' ? 'grid-cols-[12px_10px_minmax(0,1fr)_40px_24px_60px]' : 'grid-cols-[12px_10px_minmax(0,1fr)]'}`}>
                {enabled ? <Eye className="size-3 shrink-0 text-muted-foreground" /> : <EyeOff className="size-3 shrink-0 text-muted-foreground" />}
                <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: `rgb(${item.color.map((value) => Math.round(value * 255)).join(',')})` }} />
                <span className="truncate" title={item.label}>{item.label}</span>
                {activeScheme === 'feature' && <>
                  <span className="text-right text-[10px] tabular-nums">{formatPreviewTime(time)?.replaceAll(' ', '') ?? '—'}</span>
                  <span className="text-right text-[10px] tabular-nums">{percentage}</span>
                  <span className="text-right text-[10px] tabular-nums">{usage || '—'}</span>
                </>}
              </Button>
            );
          })}
          {descriptor?.kind === 'numeric' && <>
            <div className="h-2 rounded-sm" style={{ background: `linear-gradient(to right, ${descriptor.items.map((item) => `rgb(${item.color.map((value) => Math.round(value * 255)).join(',')})`).join(', ')})` }} />
            <div className="flex justify-between text-[0.65rem] text-muted-foreground"><span>{formatPreviewValue(descriptor.min ?? 0, descriptor.unit)}</span><span>{formatPreviewValue(descriptor.max ?? 0, descriptor.unit)}</span></div>
          </>}
          {!descriptor && <div className="text-xs text-muted-foreground">No data for this scheme</div>}
          {moveOptions.map((option) => {
            const travel = option.type === TRAVEL_MOVE_TYPE;
            const enabled = travel ? preview.showTravel : preview.moveVisibility[option.type] !== false;
            return <Button variant="ghost" size="xs" key={option.type} aria-pressed={enabled}
              data-testid={travel ? 'preview-travel-toggle' : `preview-move-visibility-${option.type}`}
              onClick={() => { if (travel) setShowTravel(!enabled); else setMoveVisibility(option.type, !enabled); }}
              className="sidebar-list-row grid grid-cols-[12px_10px_minmax(0,1fr)] w-full px-1 text-left">
              {enabled ? <Eye className="size-3 shrink-0 text-muted-foreground" /> : <EyeOff className="size-3 shrink-0 text-muted-foreground" />}
                <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: `rgb(${option.color.join(',')})` }} />
              <span>{option.label}</span>
            </Button>;
          })}
          </div>
        </div>
        <PreviewStatisticsFooter data={data} />
        <PreviewInspectionPanel data={data} />
      </CollapsibleContent>
    </Collapsible>
  );
});
