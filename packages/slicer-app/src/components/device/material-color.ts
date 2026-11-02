import type { ColorValue } from '@orca/platform-contract';
import type * as D from '@orca/printer-control/domain';
import type { ColorSwatchDisplay } from '@/components/ui/color-swatch';

type Color = D.MaterialColor | D.MaterialColorConfiguration;
const rgba = (value: string) => `${value}${value.length === 7 ? 'FF' : ''}`.toUpperCase();

export function materialColorSwatch(color: Color): ColorSwatchDisplay {
  return color.kind === 'solid' ? { mode: 'solid', colors: [color.rgba] }
    : { mode: color.kind === 'gradient' || color.appearance === 'gradient' ? 'gradient' : 'multicolor', colors: color.rgba };
}

/** An unrepresentable report is only a picker seed, never an implicit replacement. */
export function materialColorPickerSeed(color: Color | null | undefined, maxGradientColors: number | null): { value: ColorValue; notice?: string } {
  if (!color) return { value: { kind: 'solid', color: '#FFFFFFFF' } };
  if (color.kind === 'solid') return { value: { kind: 'solid', color: color.rgba } };
  if ((color.kind === 'gradient' || color.appearance === 'gradient') && maxGradientColors !== null
    && color.rgba.length >= 2 && color.rgba.length <= maxGradientColors)
    return { value: { kind: 'linear-gradient', colors: color.rgba } };
  return { value: { kind: 'solid', color: color.rgba[0] ?? (color.kind === 'multiple' ? color.representativeRgba : null) ?? '#FFFFFFFF' },
    notice: 'This reported color group cannot be edited here. It will be preserved unless you change the color.' };
}

export function materialColorConfiguration(value: ColorValue): D.MaterialColorConfiguration {
  return value.kind === 'solid' ? { kind: 'solid', rgba: rgba(value.color) }
    : { kind: 'gradient', rgba: value.colors.map(rgba) };
}
