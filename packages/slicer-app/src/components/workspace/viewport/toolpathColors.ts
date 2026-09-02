import type { ToolpathFeature } from '@slicer/client';

/** EMoveType::Travel in libslic3r/libvgcode. */
export const TRAVEL_MOVE_TYPE = 8;

/** libvgcode's DEFAULT_OPTIONS_COLORS entry for EOptionType::Travels. */
export const ORCA_TRAVEL_COLOR: readonly [number, number, number] = [56 / 255, 72 / 255, 155 / 255];

export const TOOLPATH_FALLBACK_COLOR: readonly [number, number, number] = [0.58, 0.58, 0.58];

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
