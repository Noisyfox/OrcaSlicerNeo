import { normalizeHexColor, type ColorValue } from '@orca/platform-contract';

export interface RgbaColor { r: number; g: number; b: number; a: number }
export interface HslaColor { h: number; s: number; l: number; a: number }
export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function hexToRgba(hex: string): RgbaColor | null {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return null;
  return { r: parseInt(normalized.slice(1, 3), 16), g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16), a: normalized.length === 9 ? parseInt(normalized.slice(7, 9), 16) / 255 : 1 };
}

export function rgbaToHex(color: RgbaColor, alpha = false): string {
  const byte = (value: number) => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0').toUpperCase();
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}${alpha ? byte(color.a * 255) : ''}`;
}

/** Preserve hue at zero saturation, and saturation at black/white. */
export function rgbaToHsla(color: RgbaColor, previous?: HslaColor): HslaColor {
  const [r, g, b] = [color.r, color.g, color.b].map(v => clamp(v, 0, 255) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const l = (max + min) / 2;
  if (delta === 0) return { h: previous?.h ?? 0, s: l === 0 || l === 1 ? previous?.s ?? 0 : 0, l: l * 100, a: color.a };
  const hue = max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { h: hue * 60, s: delta / (1 - Math.abs(2 * l - 1)) * 100, l: l * 100, a: color.a };
}

export function hslaToRgba(color: HslaColor): RgbaColor {
  const h = ((color.h % 360) + 360) % 360 / 60, s = clamp(color.s, 0, 100) / 100, l = clamp(color.l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(h % 2 - 1)), m = l - c / 2;
  const rgb = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return { r: (rgb[0] + m) * 255, g: (rgb[1] + m) * 255, b: (rgb[2] + m) * 255, a: clamp(color.a, 0, 1) };
}

export function colorValueCss(value: ColorValue): string {
  return value.kind === 'solid' ? value.color : `linear-gradient(to right, ${value.start}, ${value.end})`;
}

/** Enforce instance capabilities and explicit output format at commit boundaries. */
export function formatColorValue(value: ColorValue, alpha = false, gradient = false): ColorValue {
  const format = (hex: string) => rgbaToHex(hexToRgba(hex) ?? { r: 0, g: 0, b: 0, a: 1 }, alpha);
  return value.kind === 'linear-gradient' && gradient
    ? { kind: 'linear-gradient', start: format(value.start), end: format(value.end) }
    : { kind: 'solid', color: format(value.kind === 'solid' ? value.color : value.start) };
}

export function spectrumColor(x: number, y: number, saturation: number, alpha: number): HslaColor {
  return { h: clamp(x, 0, 1) * 360, s: saturation, l: (1 - clamp(y, 0, 1)) * 100, a: alpha };
}

/** Constant-time coordinates; no pixel readback or nearest-color search. */
export function spectrumPosition(color: HslaColor): { x: number; y: number } {
  return { x: clamp(color.h / 360, 0, 1), y: 1 - clamp(color.l / 100, 0, 1) };
}
