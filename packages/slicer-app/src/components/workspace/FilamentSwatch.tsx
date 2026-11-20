import type { FilamentSessionSlot } from '@slicer/client';
import { colorSwatchForeground, colorSwatchStyle } from '@/components/ui/color-swatch';

type Display = FilamentSessionSlot['colour']['display'];

export function filamentSwatchTitle(display: Display): string {
  return `${display.mode === 'multicolor' ? 'Multicolor' : display.mode === 'gradient' ? 'Gradient' : 'Solid'}: ${display.colors.join(' → ')}`;
}

export function filamentSlotNumberStyle(display: Display, effectiveColour: string) {
  return { ...colorSwatchStyle(display), color: colorSwatchForeground(effectiveColour) };
}

export function FilamentSwatch({ display, className = '' }: { display: Display; className?: string }) {
  return <span aria-hidden="true" className={className} style={colorSwatchStyle(display)} />;
}

export function filamentSlotChoice(slot: FilamentSessionSlot) {
  return { label: `${slot.slot} - ${slot.preset.name}`, display: slot.colour.display };
}

export function FilamentChoiceContent({ label, display }: { label: string; display: Display | null }) {
  return <>
    {display !== null && <FilamentSwatch display={display} className="size-3.5 shrink-0 rounded-xs border border-foreground/20" />}
    {label}
  </>;
}
