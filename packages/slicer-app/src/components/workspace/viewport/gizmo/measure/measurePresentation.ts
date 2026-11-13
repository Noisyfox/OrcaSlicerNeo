import type { MeasureFeature, MeasureSelection, MeasureStatus } from '@slicer/client';

export function measureNumber(value: number): string { return value.toFixed(3); }
export function measureLength(value: number): string { return `${measureNumber(value)} mm`; }

function featureName(feature: MeasureFeature): string {
  return feature.type === 'point' ? 'Vertex' : feature.type[0].toUpperCase() + feature.type.slice(1);
}

export function describeMeasureSelection(item: MeasureSelection | null): string {
  if (!item) return 'None';
  if (item.kind === 'midpoint') return 'Midpoint of edge';
  if (item.kind === 'center') return `Center of ${item.source.type}`;
  if (item.kind === 'pointOnFeature') return item.source.type === 'point' ? 'Vertex' : `Point on ${item.source.type}`;
  const name = featureName(item.value);
  if (item.value.type === 'edge') return `${name} (Length: ${measureLength(item.value.length)})`;
  if (item.value.type === 'circle') return `${name} (Diameter: ${measureLength(item.value.diameter)})`;
  return name;
}

export interface MeasureRow { readonly label: string; readonly value: string }

/** Visibility is supplied by Orca's native epsilon decisions, never inferred
 * from the rounded labels. Single-edge/circle dimensions are in the slots. */
export function measureRows(status: MeasureStatus | null): MeasureRow[] {
  if (!status?.second || !status.result) return [];
  const result = status.result, rows: MeasureRow[] = [];
  if (result.angle) rows.push({ label: 'Angle', value: `${measureNumber(result.angle.radians * 180 / Math.PI)}°` });
  if (result.infinite) rows.push({ label: result.showStrict ? 'Perpendicular distance' : 'Distance', value: measureLength(result.infinite.value) });
  if (result.strict && result.showStrict) rows.push({ label: 'Direct distance', value: measureLength(result.strict.value) });
  if (result.xyz && result.showXyz) rows.push({ label: 'Distance XYZ', value:
    `X: ${measureNumber(result.xyz[0])}, Y: ${measureNumber(result.xyz[1])}, Z: ${measureNumber(result.xyz[2])}` });
  return rows;
}
