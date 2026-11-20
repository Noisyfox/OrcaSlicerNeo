import type { FilamentSessionSlot } from '@slicer/client';
import type { ReactNode } from 'react';
import { colorSwatchForeground, colorSwatchStyle } from '@/components/ui/color-swatch';
import { mixRecipeSummary } from './mixes/mixRecipeSummary';

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
  const name = slot.mix ? mixRecipeSummary(slot.mix).description : slot.preset.name;
  return { label: `${slot.slot} - ${name}`, display: slot.colour.display };
}

export function FilamentChoiceContent({ label, display }: { label: ReactNode; display: Display | null }) {
  return <>
    {display !== null && <FilamentSwatch display={display} className="size-3.5 shrink-0 rounded-xs border border-foreground/20" />}
    {label}
  </>;
}
