import type { CSSProperties } from 'react';
import type { FilamentSessionSlot } from '@slicer/client';

type Display = FilamentSessionSlot['colour']['display'];

/** Native display semantics are already normalized at the Worker boundary. */
export function filamentSwatchStyle(display: Display): CSSProperties {
  const colors = display.colors;
  const translucent = colors.some(color => /^#[\da-f]{8}$/i.test(color) && Number.parseInt(color.slice(7), 16) < 255);
  const gradient = display.mode === 'multicolor'
    ? colors.flatMap((color, index) => [`${color} ${index / colors.length * 100}%`, `${color} ${(index + 1) / colors.length * 100}%`]).join(', ')
    : display.mode === 'solid' ? `${colors[0]}, ${colors[0]}` : colors.join(', ');
  if (translucent) return {
    backgroundColor: 'var(--color-card)',
    backgroundImage: `linear-gradient(90deg, ${gradient}), conic-gradient(var(--color-secondary) 25%, transparent 0 50%, var(--color-secondary) 0 75%, transparent 0)`,
    backgroundSize: '100% 100%, 12px 12px',
    backgroundOrigin: 'border-box',
    backgroundRepeat: 'no-repeat, repeat',
  };
  if (display.mode === 'solid') return { backgroundColor: colors[0] };
  // Bordered cells and menu swatches must draw the first/last colour through
  // their border box without repeating the last gradient tile at the left.
  const fill: CSSProperties = { backgroundColor: colors[0], backgroundOrigin: 'border-box', backgroundRepeat: 'no-repeat' };
  return { ...fill, backgroundImage: `linear-gradient(90deg, ${gradient})` };
}

export function filamentSwatchTitle(display: Display): string {
  return `${display.mode === 'multicolor' ? 'Multicolor' : display.mode === 'gradient' ? 'Gradient' : 'Solid'}: ${display.colors.join(' → ')}`;
}

export function FilamentSwatch({ display, className = '' }: { display: Display; className?: string }) {
  return <span aria-hidden="true" className={className} style={filamentSwatchStyle(display)} />;
}
