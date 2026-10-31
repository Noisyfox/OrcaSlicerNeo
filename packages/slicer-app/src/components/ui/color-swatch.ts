import type { CSSProperties } from 'react';
import { hexToRgba } from './color-picker-model';

export interface ColorSwatchDisplay {
  mode: 'solid' | 'gradient' | 'multicolor';
  colors: readonly string[];
}

/** Contrast against the visible colour, including the opaque checkerboard. */
export function colorSwatchForeground(value: string): string {
  const color = hexToRgba(value);
  if (!color) return 'var(--color-foreground)';
  // Mean of the white (#fff) and light grey (#ddd) swatch tokens in index.css.
  const brightness = color.a * (color.r * .299 + color.g * .587 + color.b * .114) + (1 - color.a) * 238;
  return brightness > 150 ? '#171717' : '#ffffff';
}

/** Shared by picker, workspace, device and print-source colour previews. */
export function colorSwatchStyle({ mode, colors }: ColorSwatchDisplay): CSSProperties {
  const translucent = colors.some(color => (hexToRgba(color)?.a ?? 1) < 1);
  const gradient = mode === 'multicolor'
    ? colors.flatMap((color, index) => [`${color} ${index / colors.length * 100}%`, `${color} ${(index + 1) / colors.length * 100}%`]).join(', ')
    : mode === 'solid' ? `${colors[0]}, ${colors[0]}` : colors.join(', ');
  if (translucent) return {
    backgroundColor: 'var(--color-swatch-background)',
    backgroundImage: `linear-gradient(90deg, ${gradient}), var(--color-swatch-checkerboard)`,
    backgroundSize: '100% 100%, 12px 12px',
    backgroundOrigin: 'border-box',
    backgroundRepeat: 'no-repeat, repeat',
  };
  if (mode === 'solid') return { backgroundColor: colors[0] };
  // Extend the endpoint colours through borders without repeating the gradient.
  return { backgroundColor: colors[0], backgroundOrigin: 'border-box', backgroundRepeat: 'no-repeat',
    backgroundImage: `linear-gradient(90deg, ${gradient})` };
}
