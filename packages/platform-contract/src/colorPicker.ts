/** Host-neutral color values. Alpha, when present, is the final HEX byte. */
export type ColorValue =
  | { kind: 'solid'; color: string }
  | { kind: 'linear-gradient'; start: string; end: string };

export const MAX_COLOR_FAVORITES = 24;

export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^#/, '');
  if (!/^(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(hex)) return null;
  const full = (hex.length < 5 ? [...hex].map(c => c + c).join('') : hex).toUpperCase();
  return '#' + (full.length === 8 && full.endsWith('FF') ? full.slice(0, 6) : full);
}

export function normalizeColorValue(value: unknown): ColorValue | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'solid') {
    const color = normalizeHexColor(candidate.color);
    return color ? { kind: 'solid', color } : null;
  }
  if (candidate.kind === 'linear-gradient') {
    const start = normalizeHexColor(candidate.start), end = normalizeHexColor(candidate.end);
    return start && end ? { kind: 'linear-gradient', start, end } : null;
  }
  return null;
}

export function colorValueKey(value: ColorValue): string {
  return JSON.stringify(normalizeColorValue(value));
}

export function normalizeColorFavorites(value: unknown): ColorValue[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: ColorValue[] = [];
  for (const item of value) {
    const normalized = normalizeColorValue(item);
    if (!normalized) continue;
    const key = colorValueKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length === MAX_COLOR_FAVORITES) break;
  }
  return result;
}

export function colorValueSupported(value: ColorValue, alpha = false, gradient = false): boolean {
  if (value.kind === 'linear-gradient' && !gradient) return false;
  const colors = value.kind === 'solid' ? [value.color] : [value.start, value.end];
  return colors.every(hex => {
    const normalized = normalizeHexColor(hex);
    return normalized !== null && (alpha || normalized.length === 7);
  });
}
