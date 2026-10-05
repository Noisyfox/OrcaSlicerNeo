import type { OptionMeta } from '@slicer/client';

// Match Orca GUI/Field.cpp::get_formatted_tooltip_text with native parent values.
const FLOAT_MAX = 3.4028234663852886e38;
const numericTypes = new Set<OptionMeta['type']>([
  'float', 'int', 'percent', 'float_or_percent', 'floats', 'ints', 'percents', 'floats_or_percents',
]);
const formatNumber = (value: number) => Number(value.toFixed(4)).toLocaleString('en-US', {
  useGrouping: false, maximumFractionDigits: 4,
});

function stringElement(serialized: string, index: number, vector: boolean): string {
  // Native string vectors use semicolons and quoted C-style escapes.
  const values: string[] = [];
  let start = 0;
  let quoted = false;
  for (let position = 0; position < serialized.length && vector; position++) {
    if (serialized[position] === '\\') { position++; continue; }
    if (serialized[position] === '"') quoted = !quoted;
    if (serialized[position] === ';' && !quoted) {
      values.push(serialized.slice(start, position));
      start = position + 1;
    }
  }
  values.push(serialized.slice(start));
  const value = values[index < values.length ? index : 0] ?? '';
  const text = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  return text.replace(/\\([nrt\\"])/g, (_match, escape: string) => ({ n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"' })[escape]!);
}

export function optionTooltip(metadata: OptionMeta | undefined, key: string, fallback = '', sourceValue = metadata?.tooltip_default): string {
  const help = metadata?.tooltip ?? fallback;
  const indexed = /^(.*)#(\d+)$/.exec(key);
  const index = indexed ? Number(indexed[2]) : 0;
  const parameterName = indexed ? `${indexed[1]}[${indexed[2]}]` : key;
  let tooltip = `${help ? `${help}\n\n` : ''}parameter name: ${parameterName}`;
  if (!metadata || sourceValue === undefined) return tooltip.replaceAll('Slic3r', 'OrcaSlicer');

  let unit = metadata.sidetext ?? '';
  if (unit === 'layers') unit = ' layers';
  if (numericTypes.has(metadata.type)) {
    const values = sourceValue.split(',');
    const value = values[index < values.length ? index : 0]!.trim();
    if (metadata.type === 'float_or_percent' || metadata.type === 'floats_or_percents') {
      unit = value.endsWith('%') ? '%' : unit.replace(' or %', '');
    }
    const number = value === '' ? NaN : Number(value.replace(/%$/, ''));
    if (Number.isFinite(number)) tooltip += `\n\nDefault: ${formatNumber(number)}${unit}`;
    if (metadata.min !== undefined && metadata.max !== undefined
      && Number.isFinite(metadata.min) && Number.isFinite(metadata.max)
      && metadata.min > -FLOAT_MAX && metadata.max < FLOAT_MAX) {
      tooltip += `\nRange: [${formatNumber(metadata.min)}${unit}, ${formatNumber(metadata.max)}${unit}]`;
    }
  } else if (metadata.type === 'bool' || metadata.type === 'bools') {
    const values = sourceValue.split(',');
    const value = values[index < values.length ? index : 0]!.trim();
    tooltip += `\n\nDefault: ${value === 'nil' || value === '' ? 'Empty string' : `${value === '1' || value === 'true' ? 'true' : 'false'}${unit}`}`;
  } else if (metadata.type === 'string' || metadata.type === 'strings') {
    const text = stringElement(sourceValue, index, metadata.type === 'strings');
    tooltip += `\n\nDefault: ${text ? `${text}${unit}` : 'Empty string'}`;
  }
  return tooltip.replaceAll('Slic3r', 'OrcaSlicer');
}
