/** Host-neutral color values. Alpha, when present, is the final HEX byte. */
export type ColorValue =
  | { kind: 'solid'; color: string }
  | { kind: 'linear-gradient'; colors: readonly string[] };

export const MAX_COLOR_FAVORITES = 16;
export const MAX_GRADIENT_COLORS = 7;

export interface ColorPickerUiState { sidebarOpen: boolean; paletteId: string }
export const DEFAULT_COLOR_PICKER_UI: ColorPickerUiState = { sidebarOpen: false, paletteId: 'basic' };
export function normalizeColorPickerUi(value: unknown): ColorPickerUiState {
  const ui = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return { sidebarOpen: ui.sidebarOpen === true,
    paletteId: typeof ui.paletteId === 'string' && ui.paletteId.length > 0 && ui.paletteId.length <= 128 ? ui.paletteId : 'basic' };
}

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
    if (!Array.isArray(candidate.colors) || candidate.colors.length < 2 || candidate.colors.length > MAX_GRADIENT_COLORS) return null;
    const colors = candidate.colors.map(normalizeHexColor);
    return colors.every((color): color is string => color !== null) ? { kind: 'linear-gradient', colors } : null;
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
  if (value.kind === 'linear-gradient' && (value.colors.length < 2 || value.colors.length > MAX_GRADIENT_COLORS)) return false;
  const colors = value.kind === 'solid' ? [value.color] : value.colors;
  return colors.every(hex => {
    const normalized = normalizeHexColor(hex);
    return normalized !== null && (alpha || normalized.length === 7);
  });
}
