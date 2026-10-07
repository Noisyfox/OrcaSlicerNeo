import type { CSSProperties } from 'react';
import type { FilamentSessionSlot } from '@slicer/client';

type Display = FilamentSessionSlot['colour']['display'];

/** Native display semantics are already normalized at the Worker boundary. */
export function filamentSwatchStyle(display: Display): CSSProperties {
  const colors = display.colors;
  if (display.mode === 'solid') return { backgroundColor: colors[0] };
  if (display.mode === 'gradient')
    return { backgroundColor: colors[0], backgroundImage: `linear-gradient(90deg, ${colors.join(', ')})` };
  const stops = colors.flatMap((color, index) => {
    const start = (index / colors.length) * 100;
    const end = ((index + 1) / colors.length) * 100;
    return [`${color} ${start}%`, `${color} ${end}%`];
  });
  return { backgroundColor: colors[0], backgroundImage: `linear-gradient(90deg, ${stops.join(', ')})` };
}

export function filamentSwatchTitle(display: Display): string {
  return `${display.mode === 'multicolor' ? 'Multicolor' : display.mode === 'gradient' ? 'Gradient' : 'Solid'}: ${display.colors.join(' → ')}`;
}

export function FilamentSwatch({ display, className = '' }: { display: Display; className?: string }) {
  return <span aria-hidden="true" className={className} style={filamentSwatchStyle(display)} />;
}
