import type { OptionMeta } from '@slicer/client';

// Match the range portion of Orca GUI/Field.cpp::get_formatted_tooltip_text.
const FLOAT_MAX = 3.4028234663852886e38;
const numericTypes = new Set<OptionMeta['type']>([
  'float', 'int', 'percent', 'float_or_percent', 'floats', 'ints', 'percents', 'floats_or_percents',
]);

export function optionTooltip(metadata: OptionMeta | undefined, fallback = '', sourceValue = metadata?.default): string {
  const help = metadata?.tooltip ?? fallback;
  if (!metadata || !numericTypes.has(metadata.type)
    || metadata.min === undefined || metadata.max === undefined
    || !Number.isFinite(metadata.min) || !Number.isFinite(metadata.max)
    || metadata.min <= -FLOAT_MAX || metadata.max >= FLOAT_MAX) return help;

  let unit = metadata.sidetext ?? '';
  if (unit === 'layers') unit = ' layers';
  if (metadata.type === 'float_or_percent' || metadata.type === 'floats_or_percents') {
    unit = sourceValue?.split(',')[0]?.trim().endsWith('%') ? '%' : unit.replace(' or %', '');
  }
  const format = (value: number) => Number(value.toFixed(4)).toLocaleString('en-US', {
    useGrouping: false, maximumFractionDigits: 4,
  });
  const range = `Range: [${format(metadata.min)}${unit}, ${format(metadata.max)}${unit}]`;
  return help ? `${help}\n\n${range}` : range;
}
