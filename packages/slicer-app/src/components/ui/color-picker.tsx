import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import { cn } from 'cn';
import { PlusIcon, XIcon } from 'lucide-react';
import { colorValueKey, colorValueSupported, MAX_COLOR_FAVORITES, normalizeColorFavorites, type ColorValue } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { clamp, colorValueCss, hexToRgba, hslaToRgba, rgbaToHex, rgbaToHsla, spectrumColor, spectrumPosition, type HslaColor } from './color-picker-model';
import { DEFAULT_COLOR_PALETTES, type ColorPalette } from './color-picker-palettes';

export interface ColorPickerProps {
  value: ColorValue;
  onChange: (value: ColorValue) => void;
  palettes?: readonly ColorPalette[];
  favorites?: readonly ColorValue[];
  onFavoriteAdd?: (value: ColorValue) => void;
  onFavoriteRemove?: (value: ColorValue) => void;
  favoritesReady?: boolean;
  enableAlpha?: boolean;
  enableGradient?: boolean;
  onValidityChange?: (valid: boolean) => void;
  disabled?: boolean;
  className?: string;
}

function ColorSwatch({ value, className }: { value: ColorValue; className?: string }) {
  return <span aria-hidden="true" className={cn('color-checkerboard block overflow-hidden rounded-sm border border-border', className)}>
    <span className="block size-full" style={{ background: colorValueCss(value) }} />
  </span>;
}

function ColorChannel({ label, value, max, onChange, disabled, gradient }: {
  label: string; value: number; max: number; onChange: (value: number) => void; disabled?: boolean; gradient: string;
}) {
  const id = useId();
  const [text, setText] = useState(String(Math.round(value)));
  useEffect(() => setText(String(Math.round(value))), [value]);
  return <Field orientation="horizontal" className="gap-2">
    <FieldLabel htmlFor={id} style={{ flex: '0 0 40px' }}>{label}</FieldLabel>
    <Slider aria-label={`${label} channel`} value={[value]} min={0} max={max} step={1} disabled={disabled}
      className="color-channel-slider min-w-0 flex-1" style={{ '--channel-gradient': gradient } as React.CSSProperties}
      onValueChange={next => onChange(Array.isArray(next) ? next[0] : next)} />
    <Input id={id} aria-label={`${label} value`} type="number" min={0} max={max} step={1} value={text} disabled={disabled}
      className="w-16 shrink-0" onChange={event => {
        setText(event.target.value);
        const next = Number(event.target.value);
        if (event.target.value !== '' && Number.isFinite(next)) onChange(clamp(next, 0, max));
      }} onBlur={() => setText(String(Math.round(value)))} />
  </Field>;
}

function ColorSpectrum({ color, onChange, disabled }: { color: HslaColor; onChange: (value: HslaColor) => void; disabled?: boolean }) {
  const pointer = useRef<number | null>(null);
  const position = spectrumPosition(color);
  const hueStops = Array.from({ length: 7 }, (_, i) => `hsl(${i * 60} ${color.s}% 50%)`).join(', ');
  const sample = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width && rect.height) onChange(spectrumColor((event.clientX - rect.left) / rect.width,
      (event.clientY - rect.top) / rect.height, color.s, color.a));
  };
  return <div className="color-spectrum relative h-40 w-full shrink-0 touch-none overflow-hidden rounded-md border border-border focus-visible:outline-2 focus-visible:outline-ring"
    role="group" aria-label="Color spectrum" aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : 0}
    style={{ background: `linear-gradient(to bottom, white, transparent 50%, black), linear-gradient(to right, ${hueStops})` }}
    onPointerDown={event => {
      if (disabled || event.button !== 0) return;
      event.preventDefault(); event.currentTarget.focus();
      pointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); sample(event);
    }} onPointerMove={event => { if (pointer.current === event.pointerId && !disabled) sample(event); }}
    onPointerUp={event => { if (pointer.current === event.pointerId) { pointer.current = null; event.currentTarget.releasePointerCapture(event.pointerId); } }}
    onPointerCancel={() => { pointer.current = null; }} onLostPointerCapture={() => { pointer.current = null; }}
    onKeyDown={event => {
      if (disabled) return;
      const step = event.shiftKey ? 10 : 1;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); onChange({ ...color, h: clamp(color.h + (event.key === 'ArrowRight' ? step : -step), 0, 360) });
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault(); onChange({ ...color, l: clamp(color.l + (event.key === 'ArrowUp' ? step : -step), 0, 100) });
      }
    }}>
    <span aria-hidden="true" className="color-spectrum-pointer absolute size-4 rounded-full border-2 border-white"
      style={{ left: `${position.x * 100}%`, top: `${position.y * 100}%` }} />
    <span className="sr-only">Use left/right for hue and up/down for lightness. Saturation is edited below.</span>
  </div>;
}

/** Controlled, host-free editor. Business commands and persistence stay outside. */
export function ColorPicker({ value, onChange, palettes = DEFAULT_COLOR_PALETTES, favorites = [],
  onFavoriteAdd, onFavoriteRemove, favoritesReady = true, enableAlpha = false, enableGradient = false,
  onValidityChange, disabled = false, className }: ColorPickerProps) {
  const [endpoint, setEndpoint] = useState<'start' | 'end'>('start');
  const isGradient = enableGradient && value.kind === 'linear-gradient';
  const hex = value.kind === 'solid' ? value.color : value[isGradient ? endpoint : 'start'];
  const [color, setColor] = useState(() => rgbaToHsla(hexToRgba(hex) ?? { r: 128, g: 128, b: 128, a: 1 }));
  const emitted = useRef<string | null>(null);
  const [mode, setMode] = useState('rgb');
  const [paletteId, setPaletteId] = useState('basic');
  const [hexText, setHexText] = useState(rgbaToHex(hslaToRgba(color), enableAlpha));
  const memories = useRef<Partial<Record<'solid' | 'start' | 'end', HslaColor>>>({});
  const lastSolid = useRef<ColorValue>({ kind: 'solid', color: hex });
  const lastGradient = useRef<ColorValue>({ kind: 'linear-gradient', start: hex, end: '#FFFFFF' });
  const colorKey = isGradient ? endpoint : 'solid';
  const hexId = useId();
  useEffect(() => {
    if (emitted.current === `${colorKey}:${hex}:${enableAlpha}`) return;
    const rgb = hexToRgba(hex);
    if (rgb) {
      if (!enableAlpha) rgb.a = 1;
      const next = rgbaToHsla(rgb, memories.current[colorKey]);
      memories.current[colorKey] = next; setColor(next); setHexText(rgbaToHex(rgb, enableAlpha));
    }
  }, [hex, colorKey, enableAlpha]);
  const format = (hex: string) => rgbaToHex(hexToRgba(hex) ?? { r: 0, g: 0, b: 0, a: 1 }, enableAlpha);
  const outputValue = (next: ColorValue): ColorValue => next.kind === 'solid'
    ? { kind: 'solid', color: format(next.color) }
    : { kind: 'linear-gradient', start: format(next.start), end: format(next.end) };
  const publish = (next: HslaColor) => {
    if (!enableAlpha) next = { ...next, a: 1 };
    const output = rgbaToHex(hslaToRgba(next), enableAlpha);
    emitted.current = `${colorKey}:${output}:${enableAlpha}`;
    memories.current[colorKey] = next; setColor(next); setHexText(output);
    const result: ColorValue = isGradient && value.kind === 'linear-gradient'
      ? outputValue({ ...value, [endpoint]: output }) : { kind: 'solid', color: output };
    if (result.kind === 'solid') lastSolid.current = result; else lastGradient.current = result;
    onChange(result);
  };
  const select = (next: ColorValue) => {
    if (!colorValueSupported(next, enableAlpha, enableGradient)) return;
    if (next.kind === 'linear-gradient') { lastGradient.current = next; onChange(outputValue(next)); return; }
    const rgba = hexToRgba(next.color);
    if (rgba) publish(rgbaToHsla(rgba, color));
  };
  const rgba = hslaToRgba(color);
  const current: ColorValue = isGradient && value.kind === 'linear-gradient'
    ? outputValue({ ...value, [endpoint]: rgbaToHex(rgba, enableAlpha) })
    : { kind: 'solid', color: rgbaToHex(rgba, enableAlpha) };
  const allFavorites = normalizeColorFavorites(favorites);
  const visibleFavorites = allFavorites.filter(item => colorValueSupported(item, enableAlpha, enableGradient));
  const alreadySaved = allFavorites.some(item => colorValueKey(item) === colorValueKey(current));
  const full = allFavorites.length >= MAX_COLOR_FAVORITES;
  const availablePalettes = palettes.filter(item => item.colors.some(color => colorValueSupported(color.value, enableAlpha, enableGradient)));
  const palette = availablePalettes.find(item => item.id === paletteId) ?? availablePalettes[0];
  const parsedHex = hexToRgba(hexText);
  const hexInvalid = !parsedHex || (!enableAlpha && parsedHex.a !== 1);
  useEffect(() => onValidityChange?.(!hexInvalid), [hexInvalid, onValidityChange]);
  const rgbChannels = ['r', 'g', 'b'] as const;
  return <div data-slot="color-picker" className={cn('flex min-w-0 gap-3', className)}>
    <div className="flex w-40 shrink-0 flex-col gap-2">
      <Select value={palette?.id ?? null} onValueChange={next => next && setPaletteId(next)} disabled={disabled}>
        <SelectTrigger className="w-full" aria-label="Color palette"><SelectValue>{palette?.name ?? 'No palette'}</SelectValue></SelectTrigger>
        <SelectContent><SelectGroup>{availablePalettes.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectGroup></SelectContent>
      </Select>
      <div aria-label="Preset colors" className="flex h-96 flex-col gap-0.5 overflow-y-auto">
        {palette?.colors.filter(item => colorValueSupported(item.value, enableAlpha, enableGradient)).map((item, index) =>
          <Button key={index} variant="ghost" size="sm" className="justify-start" disabled={disabled} onClick={() => select(item.value)} title={item.name}>
            <ColorSwatch value={item.value} className="size-5 shrink-0" /><span className="truncate">{item.name}</span>
          </Button>)}
      </div>
    </div>
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      {enableGradient && <Tabs value={isGradient ? 'gradient' : 'solid'} onValueChange={next => {
        if (isGradient) lastGradient.current = value; else lastSolid.current = current;
        onChange(outputValue(next === 'gradient' ? lastGradient.current : lastSolid.current));
      }}><TabsList variant="line"><TabsTrigger value="solid" disabled={disabled}>Color</TabsTrigger><TabsTrigger value="gradient" disabled={disabled}>Gradient</TabsTrigger></TabsList></Tabs>}
      {isGradient && <Tabs value={endpoint} onValueChange={next => setEndpoint(next === 'end' ? 'end' : 'start')}>
        <TabsList variant="line"><TabsTrigger value="start" disabled={disabled}>Start</TabsTrigger><TabsTrigger value="end" disabled={disabled}>End</TabsTrigger></TabsList>
      </Tabs>}
      <ColorSpectrum color={color} onChange={publish} disabled={disabled} />
      <Tabs value={mode} onValueChange={next => setMode(String(next))}>
        <TabsList variant="line"><TabsTrigger value="rgb" disabled={disabled}>RGB</TabsTrigger><TabsTrigger value="hsl" disabled={disabled}>HSL</TabsTrigger></TabsList>
      </Tabs>
      <FieldGroup className="gap-2">
        {mode === 'rgb' ? rgbChannels.map(channel => <ColorChannel key={channel} label={channel.toUpperCase()} value={rgba[channel]} max={255} disabled={disabled}
          gradient={`linear-gradient(to right, ${rgbaToHex({ ...rgba, [channel]: 0 })}, ${rgbaToHex({ ...rgba, [channel]: 255 })})`}
          onChange={next => publish(rgbaToHsla({ ...rgba, [channel]: next }, color))} />)
          : (['h', 's', 'l'] as const).map(channel => <ColorChannel key={channel} label={channel.toUpperCase()} value={color[channel]} max={channel === 'h' ? 360 : 100} disabled={disabled}
            gradient={channel === 'h' ? 'linear-gradient(to right, red, yellow, lime, cyan, blue, magenta, red)'
              : `linear-gradient(to right, ${rgbaToHex(hslaToRgba({ ...color, [channel]: 0 }))}, ${rgbaToHex(hslaToRgba({ ...color, [channel]: 100 }))})`}
            onChange={next => publish({ ...color, [channel]: next })} />)}
        {enableAlpha && <ColorChannel label="Alpha" value={color.a * 100} max={100} disabled={disabled}
          gradient={`linear-gradient(to right, ${rgbaToHex({ ...rgba, a: 0 }, true)}, ${rgbaToHex({ ...rgba, a: 1 }, true)})`}
          onChange={next => publish({ ...color, a: next / 100 })} />}
        <Field data-invalid={hexInvalid || undefined}>
          <FieldLabel htmlFor={hexId}>HEX</FieldLabel>
          <Input id={hexId} aria-label="HEX color" value={hexText} aria-invalid={hexInvalid} disabled={disabled} spellCheck={false}
            onChange={event => {
              setHexText(event.target.value);
              const rgb = hexToRgba(event.target.value);
              if (rgb && (enableAlpha || rgb.a === 1)) { publish(rgbaToHsla(rgb, color)); }
            }} />
          {hexInvalid && <span role="status" className="text-xs text-destructive">{enableAlpha ? 'Enter a HEX or HEX-alpha color.' : 'Enter an opaque HEX color.'}</span>}
        </Field>
      </FieldGroup>
      <div className="flex items-center gap-2">
        <ColorSwatch value={current} className="h-8 min-w-0 flex-1" />
        <Button variant="outline" size="sm" aria-label="Add favorite color" disabled={disabled || !favoritesReady || !onFavoriteAdd || full || alreadySaved || hexInvalid}
          onClick={() => onFavoriteAdd?.(current)}><PlusIcon data-icon="inline-start" />Favorite</Button>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Favorites ({allFavorites.length}/{MAX_COLOR_FAVORITES})</span>
        {full && <span role="status" className="text-xs text-muted-foreground">Remove a favorite to add another color.</span>}
        <div className="grid grid-cols-8 gap-1" aria-label="Favorite colors">
          {visibleFavorites.map(item => <div key={colorValueKey(item)} className="group relative">
            <Button variant="outline" size="icon-sm" className="w-full" aria-label={`Favorite ${item.kind === 'solid' ? item.color : `${item.start} to ${item.end}`}`} disabled={disabled} onClick={() => {
              if (item.kind === 'solid' && isGradient) { lastSolid.current = item; onChange(outputValue(item)); } else select(item);
            }}>
              <ColorSwatch value={item} className="size-5" />
            </Button>
            {onFavoriteRemove && <Button variant="secondary" size="icon-xs" className="absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
              aria-label={`Remove favorite ${item.kind === 'solid' ? item.color : `${item.start} to ${item.end}`}`} disabled={disabled || !favoritesReady} onClick={() => onFavoriteRemove(item)}><XIcon /></Button>}
          </div>)}
          {Array.from({ length: MAX_COLOR_FAVORITES - visibleFavorites.length }, (_, i) => <span key={i} aria-hidden="true" className="h-6 rounded-sm border border-border bg-control-background" />)}
        </div>
      </div>
    </div>
  </div>;
}

export { ColorSwatch };
