import { TRAVEL_MOVE_TYPE } from './previewMoveTypes';
import { useMemo } from 'react';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { findPreviewMove, createPreviewInspectionIndex } from './previewSemantics';
import type { ToolpathGeometry } from './useSliceResult';
import {
  PREVIEW_SCHEME_LABELS,
  metricForPreviewScheme,
  previewSchemeAvailable,
  previewSchemeUnit,
  formatPreviewValue,
  type PreviewColorSource,
} from './toolpathColors';

const MOVE_TYPE_LABELS: Readonly<Record<number, string>> = {
  0: 'No-op',
  1: 'Retract',
  2: 'Unretract',
  3: 'Seam',
  4: 'Tool change',
  5: 'Color change',
  6: 'Pause',
  7: 'Custom G-code',
  8: 'Travel',
  9: 'Wipe',
  10: 'Extrude',
};

function finite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

export function formatPreviewTime(seconds: number | undefined): string | undefined {
  if (!finite(seconds)) return undefined;
  let remaining = Math.max(0, Math.round(seconds));
  const hours = Math.floor(remaining / 3600);
  remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60);
  const secs = remaining - minutes * 60;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function featureName(data: ToolpathGeometry, featureId: number): string | undefined {
  const entry = data.palette.find((candidate) => candidate.id === featureId);
  return entry?.name;
}

function filamentName(data: ToolpathGeometry, tool: number): string {
  const entry = data.extruderPalette?.find((candidate) => candidate.tool === tool || candidate.id === tool);
  return entry?.name ?? `Tool ${tool + 1}`;
}

function sourceIndex(data: ToolpathGeometry): Uint32Array | undefined {
  return data.gcodeIds ?? data.source?.gcodeIds;
}

function Inspection({ data }: { data: ToolpathGeometry }) {
  const preview = useSlicerStore((state) => state.preview);
  const index = useMemo(() => createPreviewInspectionIndex(data), [data]);
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
  const moveIndex = findPreviewMove(data, index, preview.visibleLayerEnd, preview.activeMoveEnd);
  const layer = data.metadata?.layerRanges.find((entry) => entry.id === preview.visibleLayerEnd);
  if (moveIndex === null) return null;

  const moveType = data.moveTypes[moveIndex];
  const featureId = data.features[moveIndex];
  const tool = data.extruderIds[moveIndex];
  const endOffset = moveIndex * 3;
  const lineIds = sourceIndex(data);
  const mappedLine = data.metadata?.sourceLineMapping?.available && lineIds
    ? lineIds[moveIndex]
    : undefined;
  const metric = metricForPreviewScheme(preview.colorScheme);
  const metricValues = metric ? data.metrics[metric] : undefined;
  const metricValue = metricValues?.[moveIndex];
  const schemeAvailable = previewSchemeAvailable(colorSource, preview.colorScheme);
  const schemeValue = schemeAvailable && preview.colorScheme === 'feature' && moveType !== TRAVEL_MOVE_TYPE
    ? featureName(data, featureId ?? 0)
    : schemeAvailable && preview.colorScheme === 'filament'
      ? filamentName(data, tool ?? 0)
      : schemeAvailable && finite(metricValue)
        ? formatPreviewValue(metricValue, previewSchemeUnit(preview.colorScheme))
        : undefined;
  const typeLabel = MOVE_TYPE_LABELS[moveType ?? -1];
  const layerNumber = (data.layerIds[moveIndex] ?? preview.visibleLayerEnd) + 1;
  const z = layer?.z;
  const position = [data.ends[endOffset], data.ends[endOffset + 1], data.ends[endOffset + 2]];

  return (
    <div data-testid="preview-inspection-card" className="space-y-2 border-t pt-2">
      <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">Current move</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Layer</dt><dd className="text-right tabular-nums">{layerNumber}</dd>
        {finite(z) && <><dt className="text-muted-foreground">Z</dt><dd className="text-right tabular-nums">{z.toFixed(2)} mm</dd></>}
        {position.every(finite) && <><dt className="text-muted-foreground">Position</dt><dd className="text-right tabular-nums">{position.map((value) => value!.toFixed(2)).join(' / ')} mm</dd></>}
        {typeLabel && <><dt className="text-muted-foreground">Move</dt><dd className="text-right">{typeLabel}</dd></>}
        {moveType !== TRAVEL_MOVE_TYPE && featureName(data, featureId ?? 0) && <><dt className="text-muted-foreground">Feature</dt><dd className="truncate text-right">{featureName(data, featureId ?? 0)}</dd></>}
        {tool !== undefined && <><dt className="text-muted-foreground">Filament</dt><dd className="truncate text-right">{filamentName(data, tool)}</dd></>}
        {mappedLine !== undefined && <><dt className="text-muted-foreground">G-code line</dt><dd className="text-right tabular-nums">{mappedLine}</dd></>}
        {schemeValue !== undefined && <><dt className="text-muted-foreground">{PREVIEW_SCHEME_LABELS[preview.colorScheme]}</dt><dd className="truncate text-right">{schemeValue}</dd></>}
      </dl>
    </div>
  );
}

/** Read-only details for the current preview move. */
export function PreviewInspectionPanel({ data }: { data: ToolpathGeometry }) {
  return <Inspection data={data} />;
}