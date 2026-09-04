import type { PreviewAnalysis, PreviewPaletteEntry, PreviewToolpathMetrics, ToolpathFeature } from '@slicer/client';
import type { PreviewColorScheme } from '../../../stores/useSlicerStore';

/** EMoveType::Travel in libslic3r/libvgcode. */
export const TRAVEL_MOVE_TYPE = 8;

/** libvgcode's DEFAULT_OPTIONS_COLORS entry for EOptionType::Travels. */
export const ORCA_TRAVEL_COLOR: readonly [number, number, number] = [56 / 255, 72 / 255, 155 / 255];

export const TOOLPATH_FALLBACK_COLOR: readonly [number, number, number] = [0.58, 0.58, 0.58];

/** libvgcode's DEFAULT_RANGES_COLORS, kept in the native order. */
export const ORCA_RANGE_COLORS: readonly (readonly [number, number, number])[] = [
  [11, 44, 122], [19, 89, 133], [28, 136, 145], [4, 214, 15], [170, 242, 0],
  [252, 249, 3], [245, 206, 10], [227, 136, 32], [209, 104, 48], [194, 82, 60], [148, 38, 22],
].map((color) => color.map((value) => value / 255) as [number, number, number]);

export interface PreviewColorSource {
  readonly palette: readonly ToolpathFeature[];
  readonly features: Uint32Array;
  readonly moveTypes: Uint8Array;
  readonly extruderIds: Uint8Array;
  readonly metrics: PreviewToolpathMetrics;
  readonly layerIds: Uint32Array;
  readonly extruderPalette?: readonly PreviewPaletteEntry[];
  readonly analysis?: PreviewAnalysis;
}

export interface PreviewLegendItem {
  readonly id: number;
  readonly label: string;
  readonly color: readonly [number, number, number];
  readonly value?: number;
}

export interface PreviewSchemeDescriptor {
  readonly scheme: PreviewColorScheme;
  readonly label: string;
  readonly kind: 'categorical' | 'numeric';
  readonly unit?: string;
  readonly min?: number;
  readonly max?: number;
  readonly items: readonly PreviewLegendItem[];
}

export const PREVIEW_SCHEME_LABELS: Readonly<Record<PreviewColorScheme, string>> = {
  feature: 'Feature / Line Type',
  filament: 'Filament / Tool',
  speed: 'Speed',
  volumetricFlow: 'Volumetric Flow',
  layerTime: 'Layer Time',
  temperature: 'Temperature',
  fanSpeed: 'Fan Speed',
};

export function metricForPreviewScheme(scheme: PreviewColorScheme): keyof PreviewToolpathMetrics | null {
  switch (scheme) {
    case 'speed': return 'feedrate';
    case 'volumetricFlow': return 'volumetricFlow';
    case 'layerTime': return 'layerDuration';
    case 'temperature': return 'temperature';
    case 'fanSpeed': return 'fanSpeed';
    default: return null;
  }
}

export function previewSchemeUnit(scheme: PreviewColorScheme): string | undefined {
  return scheme === 'speed' ? 'mm/s'
    : scheme === 'volumetricFlow' ? 'mm³/s'
      : scheme === 'layerTime' ? 's'
        : scheme === 'temperature' ? '°C'
          : scheme === 'fanSpeed' ? '%'
            : undefined;
}

function rangeForScheme(source: PreviewColorSource, scheme: PreviewColorScheme): { min: number; max: number } | null {
  const metric = metricForPreviewScheme(scheme);
  if (!metric) return null;
  const values = source.analysis?.metricRanges[metric];
  return values && Number.isFinite(values.min) && Number.isFinite(values.max) ? values : null;
}

function paletteColor(entry: ToolpathFeature | undefined): [number, number, number] {
  return normalizedColor(entry?.color ?? TOOLPATH_FALLBACK_COLOR);
}

function filamentEntry(source: PreviewColorSource, tool: number): PreviewPaletteEntry | undefined {
  return source.extruderPalette?.find((entry) => entry.tool === tool || entry.id === tool);
}

function numericValue(source: PreviewColorSource, scheme: PreviewColorScheme, index: number): number | undefined {
  const metric = metricForPreviewScheme(scheme);
  if (!metric) return undefined;
  const values = source.metrics[metric];
  if (!values) return undefined;
  return values[index];
}

/** Map a value using libvgcode's linear ColorRange interpolation. */
export function colorForPreviewValue(value: number, min: number, max: number): [number, number, number] {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) return [...TOOLPATH_FALLBACK_COLOR];
  const t = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;
  const position = t * (ORCA_RANGE_COLORS.length - 1);
  const low = Math.min(ORCA_RANGE_COLORS.length - 1, Math.floor(position));
  const high = Math.min(ORCA_RANGE_COLORS.length - 1, low + 1);
  const f = position - low;
  return [
    ORCA_RANGE_COLORS[low]![0] + (ORCA_RANGE_COLORS[high]![0] - ORCA_RANGE_COLORS[low]![0]) * f,
    ORCA_RANGE_COLORS[low]![1] + (ORCA_RANGE_COLORS[high]![1] - ORCA_RANGE_COLORS[low]![1]) * f,
    ORCA_RANGE_COLORS[low]![2] + (ORCA_RANGE_COLORS[high]![2] - ORCA_RANGE_COLORS[low]![2]) * f,
  ];
}

export function previewSchemeAvailable(source: PreviewColorSource, scheme: PreviewColorScheme): boolean {
  if (scheme === 'feature') return source.features.length > 0;
  if (scheme === 'filament') {
    if (!source.extruderPalette?.length) return false;
    return [...new Set(Array.from(source.extruderIds))].every((tool) => filamentEntry(source, tool) !== undefined);
  }
  return rangeForScheme(source, scheme) !== null;
}

export function describePreviewScheme(source: PreviewColorSource, scheme: PreviewColorScheme): PreviewSchemeDescriptor | null {
  if (!previewSchemeAvailable(source, scheme)) return null;
  if (scheme === 'feature') {
    const ids = [...new Set(Array.from(source.features))];
    return { scheme, label: PREVIEW_SCHEME_LABELS[scheme], kind: 'categorical', items: ids.map((id) => {
      const entry = source.palette.find((candidate) => candidate.id === id) ?? source.palette[id];
      return { id, label: entry?.name ?? `Feature ${id}`, color: paletteColor(entry) };
    }) };
  }
  if (scheme === 'filament') {
    const ids = [...new Set(Array.from(source.extruderIds))].sort((a, b) => a - b);
    return { scheme, label: PREVIEW_SCHEME_LABELS[scheme], kind: 'categorical', items: ids.map((id) => {
      const entry = filamentEntry(source, id);
      return { id, label: entry?.name ?? `Tool ${id + 1}`, color: paletteColor(entry) };
    }) };
  }
  const range = rangeForScheme(source, scheme);
  if (!range) return null;
  const unit = previewSchemeUnit(scheme)!;
  const items = Array.from({ length: 5 }, (_, i) => {
    const value = range.min + (range.max - range.min) * i / 4;
    return { id: i, label: formatPreviewValue(value, unit), value, color: colorForPreviewValue(value, range.min, range.max) };
  });
  return { scheme, label: PREVIEW_SCHEME_LABELS[scheme], kind: 'numeric', unit, min: range.min, max: range.max, items };
}

export function formatPreviewValue(value: number, unit?: string): string {
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  return `${value.toFixed(digits)}${unit ? ` ${unit}` : ''}`;
}

function normalizedColor(color: readonly [number, number, number], fallback = TOOLPATH_FALLBACK_COLOR): [number, number, number] {
  const values = color.map((value, index) => Number.isFinite(value) ? value : fallback[index]) as [number, number, number];
  const scale = values.some((value) => Math.abs(value) > 1) ? 1 / 255 : 1;
  return [values[0] * scale, values[1] * scale, values[2] * scale];
}

/**
 * Resolve the display colour for one segment.
 *
 * Travel colour is intentionally selected from move type, not the extrusion
 * role. The bridge preserves a role on travel moves for data compatibility,
 * but libvgcode treats travel as an option category and always uses the
 * dedicated travel colour in Feature Type mode.
 */
export function resolveToolpathColor(
  palette: readonly ToolpathFeature[],
  feature: number,
  moveType: number,
): [number, number, number] {
  if (moveType === TRAVEL_MOVE_TYPE) return [...ORCA_TRAVEL_COLOR];
  const entry = palette.find((candidate) => candidate.id === feature) ?? palette[feature];
  return normalizedColor(entry?.color ?? TOOLPATH_FALLBACK_COLOR);
}

/** Resolve one segment's color using the active Orca-style view scheme. */
export function resolvePreviewColor(
  source: PreviewColorSource,
  index: number,
  scheme: PreviewColorScheme,
): [number, number, number] {
  if (source.moveTypes[index] === TRAVEL_MOVE_TYPE) return [...ORCA_TRAVEL_COLOR];
  if (scheme === 'feature') return resolveToolpathColor(source.palette, source.features[index] ?? 0, source.moveTypes[index] ?? 0);
  if (scheme === 'filament') return paletteColor(filamentEntry(source, source.extruderIds[index] ?? 0));
  const range = rangeForScheme(source, scheme);
  const value = numericValue(source, scheme, index);
  return range && value !== undefined ? colorForPreviewValue(value, range.min, range.max) : [...TOOLPATH_FALLBACK_COLOR];
}
