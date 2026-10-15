import { useCallback, useEffect, useId, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { cn } from 'cn';
import { MinusIcon, PanelLeftIcon, PlusIcon, RotateCcwIcon, SearchIcon, StarIcon, XIcon } from 'lucide-react';
import { colorValueKey, colorValueSupported, DEFAULT_COLOR_PICKER_UI, MAX_COLOR_FAVORITES, MAX_GRADIENT_COLORS, normalizeColorFavorites, type ColorPickerUiState, type ColorValue } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxTrigger, ComboboxValue } from '@/components/ui/combobox';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { TooltipFor } from '@/components/ui/tooltip';
import { clamp, colorValueCss, formatColorValue, hexToRgba, hslaToRgba, nextGradientColor, rgbaToHex, rgbaToHsla, spectrumColor, spectrumPosition, type HslaColor } from './color-picker-model';
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
  uiState?: ColorPickerUiState;
  onUiStateChange?: (ui: ColorPickerUiState) => void;
  notice?: string;
  actions?: ReactNode;
  disabled?: boolean;
  className?: string;
}

function ColorSwatch({ value, className }: { value: ColorValue; className?: string }) {
  return <span aria-hidden="true" className={cn('color-checkerboard block overflow-hidden rounded-sm', className)}>
    <span className="block size-full" style={{ background: colorValueCss(value) }} />
  </span>;
}

function useWheelValue<T extends HTMLElement>(ref: RefObject<T | null>, value: number, max: number, step: number, disabled: boolean | undefined, onChange: (value: number) => void) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (disabled || event.deltaY === 0) return;
      event.preventDefault(); onChange(clamp(value + (event.deltaY > 0 ? -step : step), 0, max));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [ref, value, max, step, disabled, onChange]);
}

function ColorNumber({ label, value, max, onChange, onValidityChange, disabled }: {
  label: string; value: number; max: number; onChange: (value: number) => void;
  onValidityChange: (label: string, valid: boolean) => void; disabled?: boolean;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(String(Math.round(value)));
  const invalid = text === '' || !Number.isFinite(Number(text)) || Number(text) < 0 || Number(text) > max;
  useEffect(() => { setText(String(Math.round(value))); onValidityChange(label, true); }, [value, label, onValidityChange]);
  useWheelValue(input, Number(text) || 0, max, 1, disabled, next => {
    setText(String(next)); onValidityChange(label, true); onChange(next);
  });
  return <Field orientation="horizontal" className="min-w-0 gap-1 rounded-sm bg-control-background pl-1" data-invalid={invalid || undefined}>
    <FieldLabel htmlFor={id} className="shrink-0">{label === 'Alpha' ? 'α' : label}</FieldLabel>
    <Input ref={input} id={id} aria-label={`${label} value`} type="number" required min={0} max={max} step={1} value={text} disabled={disabled}
      aria-invalid={invalid} className="h-7 min-w-0 border-0 px-1 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" onChange={event => {
        const text = event.target.value, next = Number(text);
        const valid = text !== '' && Number.isFinite(next);
        const clamped = clamp(next, 0, max);
        setText(valid && clamped !== next ? String(clamped) : text); onValidityChange(label, valid);
        if (valid) onChange(clamped);
      }} onBlur={() => { if (!invalid) setText(String(Math.round(value))); }} />
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
  return <div className="color-spectrum relative min-h-16 min-w-0 flex-1 touch-none overflow-hidden rounded-md focus-visible:outline-2 focus-visible:outline-ring"
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
    <span className="sr-only">Use left/right for hue and up/down for lightness. Saturation is edited beside the spectrum.</span>
  </div>;
}

/** Controlled, host-free editor. Business commands and persistence stay outside. */
export function ColorPicker({ value, onChange, palettes = DEFAULT_COLOR_PALETTES, favorites = [],
  onFavoriteAdd, onFavoriteRemove, favoritesReady = true, enableAlpha = false, enableGradient = false,
  onValidityChange, uiState, onUiStateChange, notice, actions, disabled = false, className }: ColorPickerProps) {
  const [localUi, setLocalUi] = useState(DEFAULT_COLOR_PICKER_UI);
  const ui = uiState ?? localUi;
  const updateUi = (next: ColorPickerUiState) => { setLocalUi(next); onUiStateChange?.(next); };
  const [endpoint, setEndpoint] = useState(0);
  const isGradient = enableGradient && value.kind === 'linear-gradient';
  const active = isGradient ? Math.min(endpoint, value.colors.length - 1) : 0;
  const hex = value.kind === 'solid' ? value.color : value.colors[active];
  const [color, setColor] = useState(() => rgbaToHsla(hexToRgba(hex)!));
  const emitted = useRef<string | null>(null);
  const [paletteSearch, setPaletteSearch] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const filterInput = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const [opacityOpen, setOpacityOpen] = useState(false);
  const saturationSlider = useRef<HTMLDivElement>(null), opacitySlider = useRef<HTMLDivElement>(null);
  const [hexText, setHexText] = useState(rgbaToHex(hslaToRgba(color), enableAlpha).slice(1));
  const [invalidChannels, setInvalidChannels] = useState<Record<string, boolean>>({});
  const [reset, setReset] = useState(0);
  const channelValidity = useCallback((label: string, valid: boolean) => {
    setInvalidChannels(previous => previous[label] === !valid ? previous : { ...previous, [label]: !valid });
  }, []);
  const memories = useRef<Record<string, HslaColor>>({});
  const original = useRef(value);
  const lastSolid = useRef<ColorValue>({ kind: 'solid', color: hex });
  const lastGradient = useRef<ColorValue | null>(isGradient ? value : null);
  const colorKey = isGradient ? String(active) : 'solid';
  const hexId = useId(), palettePanelId = useId();
  const format = (next: ColorValue) => formatColorValue(next, enableAlpha, enableGradient);
  useEffect(() => {
    const rgb = hexToRgba(hex)!;
    if (!enableAlpha) rgb.a = 1;
    if (emitted.current === `${colorKey}:${rgbaToHex(rgb, enableAlpha)}:${enableAlpha}`) return;
    const next = rgbaToHsla(rgb, memories.current[colorKey]);
    memories.current[colorKey] = next; setColor(next); setHexText(rgbaToHex(rgb, enableAlpha).slice(1));
  }, [hex, colorKey, enableAlpha]);
  const clearEditors = () => { setReset(n => n + 1); setInvalidChannels({}); };
  const apply = (next: ColorValue) => {
    if (!colorValueSupported(next, true, enableGradient)) return;
    const formatted = format(next);
    const activeHex = formatted.kind === 'solid' ? formatted.color : formatted.colors[Math.min(endpoint, formatted.colors.length - 1)];
    clearEditors(); setColor(rgbaToHsla(hexToRgba(activeHex)!, memories.current[colorKey])); setHexText(activeHex.slice(1));
    if (formatted.kind === 'solid') lastSolid.current = formatted; else lastGradient.current = formatted;
    emitted.current = null; onChange(formatted);
  };
  const publish = (next: HslaColor, syncHex = true) => {
    if (!enableAlpha) next = { ...next, a: 1 };
    const output = rgbaToHex(hslaToRgba(next), enableAlpha);
    emitted.current = `${colorKey}:${output}:${enableAlpha}`;
    memories.current[colorKey] = next; setColor(next);
    if (syncHex) setHexText(output.slice(1));
    const result: ColorValue = isGradient
      ? format({ kind: 'linear-gradient', colors: value.colors.map((hex, index) => index === active ? output : hex) })
      : { kind: 'solid', color: output };
    if (result.kind === 'solid') lastSolid.current = result; else lastGradient.current = result;
    onChange(result);
  };
  const selectPalette = (next: ColorValue) => {
    if (next.kind === 'linear-gradient') { apply(next); return; }
    clearEditors();
    const rgba = hexToRgba(next.color)!;
    if (enableAlpha) rgba.a = color.a;
    publish(rgbaToHsla(rgba, color));
  };
  const rgba = hslaToRgba(color);
  const current = format(value);
  const allFavorites = normalizeColorFavorites(favorites);
  const visibleFavorites = allFavorites.filter(item => colorValueSupported(item, true, enableGradient));
  const alreadySaved = allFavorites.some(item => colorValueKey(item) === colorValueKey(current));
  const full = allFavorites.length >= MAX_COLOR_FAVORITES;
  const availablePalettes = palettes.filter(item => item.colors.some(color => colorValueSupported(color.value, enableAlpha, enableGradient)));
  const palette = availablePalettes.find(item => item.id === ui.paletteId) ?? availablePalettes.find(item => item.id === 'basic') ?? availablePalettes[0];
  const query = filter.trim().toLowerCase();
  const paletteColors = palette?.colors.filter(item => {
    if (!colorValueSupported(item.value, enableAlpha, enableGradient)) return false;
    const text = `${item.name} ${item.value.kind === 'solid' ? item.value.color : item.value.colors.join(' ')}`.toLowerCase();
    return !query || query.split(/\s+/).every(word => text.includes(word.replace(/^#/, '')));
  }) ?? [];
  const parsedHex = hexToRgba(hexText);
  const hexInvalid = !parsedHex || (!enableAlpha && parsedHex.a !== 1);
  const valid = !hexInvalid && !Object.entries(invalidChannels).some(([label, invalid]) => invalid && (label !== 'Alpha' || enableAlpha));
  useEffect(() => onValidityChange?.(valid), [valid, onValidityChange]);
  useEffect(() => { if (filterOpen) filterInput.current?.focus(); }, [filterOpen]);
  useWheelValue(saturationSlider, color.s, 100, 5, disabled, next => { clearEditors(); publish({ ...color, s: next }); });
  useWheelValue(opacitySlider, color.a * 100, 100, 5, disabled, next => publish({ ...color, a: Math.round(next * 255 / 100) / 255 }));
  const colorLabel = (item: ColorValue) => item.kind === 'solid' ? item.color : item.colors.join(' → ');
  const changeMode = (next: unknown) => {
    setOpacityOpen(false);
    if (isGradient) lastGradient.current = value; else lastSolid.current = current;
    if (next === 'gradient') {
      setEndpoint(0);
      apply(lastGradient.current ?? { kind: 'linear-gradient', colors: [hex, nextGradientColor(hex)] });
    } else apply(lastSolid.current);
  };
  return <div data-slot="color-picker" className={cn('flex w-max max-w-full min-h-0 gap-3', className)}
    onFocusCapture={event => { if (!(event.target as HTMLElement).closest('[data-opacity-control]')) setOpacityOpen(false); }}
    onPointerDownCapture={event => { if (!(event.target as HTMLElement).closest('[data-opacity-control]')) setOpacityOpen(false); }}>
    {ui.sidebarOpen && <div id={palettePanelId} className="relative w-40 shrink-0">
      <div className="absolute inset-0 flex min-h-0 flex-col gap-2">
        <div aria-label="Preset colors" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          {paletteColors.map((item, index) => <Button key={index} variant="ghost" size="sm" className="justify-start" disabled={disabled} onClick={() => selectPalette(item.value)} title={item.name}>
            <ColorSwatch value={item.value} className="size-5 shrink-0" /><span className="truncate">{item.name}</span>
          </Button>)}
          {!paletteColors.length && <span role="status" className="text-muted-foreground">No matching colors</span>}
        </div>
        <div className="flex min-w-0 items-center gap-1">
          {filterOpen ? <Input ref={filterInput} aria-label="Filter colors" placeholder="Filter colors" value={filter} disabled={disabled}
            className="min-w-0 border-0" onChange={event => setFilter(event.target.value)} onKeyDown={event => {
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setFilterOpen(false); setFilter(''); searchButton.current?.focus(); }
            }} /> : <Combobox items={availablePalettes.map(item => item.name)} value={palette?.name ?? null}
              inputValue={paletteSearch} onInputValueChange={setPaletteSearch} disabled={disabled}
              onValueChange={name => { const next = availablePalettes.find(item => item.name === name); if (next) updateUi({ ...ui, paletteId: next.id }); }}>
              <ComboboxTrigger variant="sidebar" className="min-w-0 flex-1" aria-label="Color palette" render={<Button variant="ghost" size="sm" />}>
                <span className="min-w-0 flex-1 truncate text-left"><ComboboxValue placeholder="No palette" /></span>
              </ComboboxTrigger>
              <ComboboxContent>
                <ComboboxInput placeholder="Search palettes…" showTrigger={false} searchValue={paletteSearch} onClearSearch={() => setPaletteSearch('')} />
                <ComboboxList>{name => <ComboboxItem key={name} value={name}>{name}</ComboboxItem>}</ComboboxList>
                <ComboboxEmpty>No matching palettes</ComboboxEmpty>
              </ComboboxContent>
            </Combobox>}
          <Button ref={searchButton} variant="settings" size="icon-sm" aria-label={filterOpen ? 'Close color search' : 'Search colors'} aria-pressed={filterOpen}
            disabled={disabled} onClick={() => { setFilterOpen(!filterOpen); setFilter(''); }}>{filterOpen ? <XIcon /> : <SearchIcon />}</Button>
        </div>
      </div>
    </div>}
    <div className="flex min-h-0 w-[330px] min-w-0 flex-col gap-2">
      {notice && <p role="status" className="shrink-0 text-muted-foreground">{notice}</p>}
      <div className="flex h-[150px] min-h-16 shrink gap-2">
        <Slider ref={saturationSlider} aria-label="Saturation" orientation="vertical" min={0} max={100} step={0.1} value={[color.s]} disabled={disabled}
          className="color-channel-slider color-saturation-slider w-4 shrink-0"
          style={{ '--channel-gradient': `linear-gradient(to top, hsl(${color.h} 0% ${color.l}%), hsl(${color.h} 100% ${color.l}%))` } as React.CSSProperties}
          onValueChange={next => { clearEditors(); publish({ ...color, s: Array.isArray(next) ? next[0] : next }); }} />
        <ColorSpectrum color={color} onChange={next => { clearEditors(); publish(next); }} disabled={disabled} />
      </div>
      <div data-slot="color-picker-editor-grid" className="flex shrink-0 gap-1.5">
        <FieldGroup className="min-w-0 flex-1 gap-1.5">
          <div className="h-7">{enableGradient && <Tabs value={isGradient ? 'gradient' : 'solid'} onValueChange={changeMode}>
            <TabsList className="h-7 w-full"><TabsTrigger value="solid" disabled={disabled}>Solid</TabsTrigger><TabsTrigger value="gradient" disabled={disabled}>Gradient</TabsTrigger></TabsList>
          </Tabs>}</div>
          <div className="flex min-w-0 gap-1.5">
            <Field orientation="horizontal" className="min-w-0 flex-1 gap-1 rounded-sm bg-control-background pl-1" data-invalid={hexInvalid || undefined}>
              <FieldLabel htmlFor={hexId}>#</FieldLabel>
              <Input id={hexId} aria-label="HEX color" className="h-7 min-w-0 border-0 px-1" value={hexText} aria-invalid={hexInvalid} disabled={disabled} spellCheck={false}
                onChange={event => {
                  setHexText(event.target.value);
                  const rgb = hexToRgba(event.target.value);
                  if (rgb && (enableAlpha || rgb.a === 1)) {
                    if (enableAlpha && event.target.value.trim().replace(/^#/, '').length <= 6) rgb.a = color.a;
                    publish(rgbaToHsla(rgb, color), false);
                  }
                }} onBlur={() => { if (!hexInvalid) setHexText(rgbaToHex(hslaToRgba(color), enableAlpha).slice(1)); }} />
            </Field>
            {enableAlpha && <div data-opacity-control className="w-14 shrink-0" onFocusCapture={() => setOpacityOpen(true)} onClick={() => setOpacityOpen(true)}>
              <ColorNumber key={`alpha-${reset}`} label="Alpha" value={color.a * 100} max={100} disabled={disabled} onValidityChange={channelValidity} onChange={next => publish({ ...color, a: Math.round(next * 255 / 100) / 255 })} />
            </div>}
          </div>
          <div className="flex h-7 items-center" data-slot="color-picker-stop-row">
            {enableAlpha && opacityOpen ? <div data-opacity-control className="w-full">
              <Slider ref={opacitySlider} aria-label="Opacity" min={0} max={100} step={0.1} value={[color.a * 100]} disabled={disabled} className="color-channel-slider"
                style={{ '--channel-gradient': `linear-gradient(to right, ${rgbaToHex({ ...rgba, a: 0 }, true)}, ${rgbaToHex({ ...rgba, a: 1 }, true)})` } as React.CSSProperties}
                onValueChange={next => publish({ ...color, a: Math.round((Array.isArray(next) ? next[0] : next) * 255 / 100) / 255 })} />
            </div> : isGradient && <>
              <Tabs value={String(active)} className="min-w-0 flex-1" onValueChange={next => { clearEditors(); emitted.current = null; setEndpoint(Number(next)); }}>
                <TabsList aria-label="Gradient colors" className="color-gradient-stops relative h-7 w-full p-0" style={{ '--gradient-colors': colorValueCss(current) } as React.CSSProperties}
                  onClick={event => { if (disabled || event.target !== event.currentTarget) return; const rect = event.currentTarget.getBoundingClientRect(); clearEditors(); setEndpoint(Math.round(clamp((event.clientX - rect.left) / rect.width, 0, 1) * (value.colors.length - 1))); }}>
                  {value.colors.map((hex, index) => <TabsTrigger key={index} value={String(index)} disabled={disabled} aria-label={`Gradient color ${index + 1}`}
                    className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-sm p-0" style={{ left: `calc(10px + (100% - 20px) * ${index / (value.colors.length - 1)})`, background: hex }} />)}
                </TabsList>
              </Tabs>
              <div className="ml-2 flex shrink-0 gap-1">
                {value.colors.length > 2 && <Button variant="settings" size="icon-xs" aria-label="Remove color" disabled={disabled} onClick={() => {
                  const colors = value.colors.filter((_, index) => index !== active); setEndpoint(Math.min(active, colors.length - 1)); memories.current = {}; apply({ kind: 'linear-gradient', colors });
                }}><MinusIcon /></Button>}
                <TooltipFor disabled={disabled || value.colors.length >= MAX_GRADIENT_COLORS} content={value.colors.length >= MAX_GRADIENT_COLORS ? `Up to ${MAX_GRADIENT_COLORS} colors supported.` : 'Add color'}>
                  <Button variant="settings" size="icon-xs" aria-label="Add color" disabled={disabled || value.colors.length >= MAX_GRADIENT_COLORS} onClick={() => {
                    if (disabled || value.colors.length >= MAX_GRADIENT_COLORS) return;
                    const colors = [...value.colors]; colors.splice(active + 1, 0, nextGradientColor(hex)); setEndpoint(active + 1); memories.current = {}; apply({ kind: 'linear-gradient', colors });
                  }}><PlusIcon /></Button>
                </TooltipFor>
              </div>
            </>}
          </div>
        </FieldGroup>
        <FieldGroup className="w-14 shrink-0 gap-1.5">
          {(['h', 's', 'l'] as const).map(channel => <ColorNumber key={`${reset}-${channel}`} label={channel.toUpperCase()} value={color[channel]} max={channel === 'h' ? 360 : 100} disabled={disabled}
            onValidityChange={channelValidity} onChange={next => publish({ ...color, [channel]: next })} />)}
        </FieldGroup>
        <FieldGroup className="w-14 shrink-0 gap-1.5">
          {(['r', 'g', 'b'] as const).map(channel => <ColorNumber key={`${reset}-${channel}`} label={channel.toUpperCase()} value={rgba[channel]} max={255} disabled={disabled}
            onValidityChange={channelValidity} onChange={next => publish(rgbaToHsla({ ...rgba, [channel]: next }, color))} />)}
        </FieldGroup>
      </div>
      {!valid && <span role="status" className="shrink-0 text-xs text-destructive">{hexInvalid ? (enableAlpha ? 'Enter a HEX or HEX-alpha color.' : 'Enter an opaque HEX color.') : 'Enter a channel value within its range.'}</span>}
      <div className="flex shrink-0 gap-1">
        <TooltipFor content="Original color"><Button variant="settings" className="relative h-[68px] w-14 overflow-hidden p-0" aria-label="Original color" disabled={disabled} onClick={() => { setEndpoint(0); memories.current = {}; apply(format(original.current)); }}>
          <ColorSwatch value={format(original.current)} className="size-full" /><RotateCcwIcon className="absolute opacity-0 group-hover/button:opacity-100" />
        </Button></TooltipFor>
        <TooltipFor content={alreadySaved ? 'Move favorite to first' : 'Save current color'}><Button variant="settings" className="relative h-[68px] w-14 overflow-hidden p-0 disabled:opacity-100" aria-label="Add favorite color"
          disabled={disabled || !favoritesReady || !onFavoriteAdd || (full && !alreadySaved) || !valid} onClick={() => onFavoriteAdd?.(current)}>
          <ColorSwatch value={current} className="size-full" /><StarIcon className="absolute opacity-0 group-hover/button:opacity-100" />
        </Button></TooltipFor>
        <div className="grid min-w-0 flex-1 grid-cols-8 gap-1" aria-label="Favorite colors">
          {visibleFavorites.map(item => {
            const favoriteButton = <Button variant="input" size="icon-sm" className="h-5 w-full border-0 p-0" aria-label={`Favorite ${item.kind === 'solid' ? item.color : item.colors.join(' to ')}`} disabled={disabled} onClick={() => apply(item)} />;
            return <div key={colorValueKey(item)} className="h-5 min-w-0">
              {onFavoriteRemove ? <ContextMenu disabled={disabled}>
                <TooltipFor content={colorLabel(item)}><span className="block h-5 w-full"><ContextMenuTrigger render={favoriteButton}><ColorSwatch value={item} className="size-full" /></ContextMenuTrigger></span></TooltipFor>
                <ContextMenuContent><ContextMenuGroup><ContextMenuItem variant="destructive" disabled={disabled || !favoritesReady} onClick={() => onFavoriteRemove(item)}>Remove favorite</ContextMenuItem></ContextMenuGroup></ContextMenuContent>
              </ContextMenu> : <TooltipFor content={colorLabel(item)}><Button {...favoriteButton.props}><ColorSwatch value={item} className="size-full" /></Button></TooltipFor>}
            </div>;
          })}
          {Array.from({ length: MAX_COLOR_FAVORITES - visibleFavorites.length }, (_, i) => <span key={i} aria-hidden="true" className="h-5 rounded-sm bg-control-background" />)}
        </div>
      </div>
      {full && <span role="status" className="shrink-0 text-xs text-muted-foreground">Remove a favorite to add another color.</span>}
      <div className="flex shrink-0 items-center gap-2 pt-1">
        <Button variant="settings" size="icon" aria-label="Palettes" aria-expanded={ui.sidebarOpen} aria-controls={palettePanelId} disabled={disabled || !favoritesReady} onClick={() => updateUi({ ...ui, sidebarOpen: !ui.sidebarOpen })}><PanelLeftIcon /></Button>
        <div className="flex-1" />{actions}
      </div>
    </div>
  </div>;
}

export { ColorSwatch };
