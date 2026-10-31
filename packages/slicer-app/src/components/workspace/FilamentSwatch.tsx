import type { FilamentSessionSlot } from '@slicer/client';
import { colorSwatchStyle } from '@/components/ui/color-swatch';

type Display = FilamentSessionSlot['colour']['display'];

export function filamentSwatchTitle(display: Display): string {
  return `${display.mode === 'multicolor' ? 'Multicolor' : display.mode === 'gradient' ? 'Gradient' : 'Solid'}: ${display.colors.join(' → ')}`;
}

export function FilamentSwatch({ display, className = '' }: { display: Display; className?: string }) {
  return <span aria-hidden="true" className={className} style={colorSwatchStyle(display)} />;
}
