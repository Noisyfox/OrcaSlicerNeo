# slider

2026-08-16 — transformation engine (legacy `default` style, no golden replay), anatomy checked against `@base-ui/react@1.7.0` d.ts and the base registry slider; verdict: migrated, no behavior deltas.

## Changed

- `apps/desktop/src/renderer/src/components/ui/slider.tsx` —
  - Import: `@radix-ui/react-slider` → `import { Slider as SliderPrimitive } from '@base-ui/react/slider'`.
  - Anatomy: `Root > Track > (Range, Thumb)` → `Root > Control > Track > (Indicator, Thumb)`.
    `Control` is the new interactive surface, so the layout classes that used
    to sit on the Radix Root (`relative flex w-full touch-none select-none
    items-center`) moved onto `Control` (mirrors the base registry: Root stays
    classless, Control carries flex/w-full/items-center).
  - `Range` → `Indicator` (Base UI fills width inline, same as Radix did, so
    the `absolute h-full bg-primary` classes map verbatim).
  - Old `Track` classes (`relative h-1.5 w-full grow overflow-hidden rounded-full
    bg-secondary`) stay on `Track`, now nested inside `Control`; `Thumb`
    classes unchanged (`block h-4 w-4 rounded-full border border-primary/50
    bg-background shadow transition-colors focus-visible:outline-none
    focus-visible:ring-1 focus-visible:ring-ring`).
  - Added `thumbAlignment="edge"` on Root — preserves the Radix
    thumb-inside-track behavior at min/max (Base UI defaults to `'center'`).
  - `Slider.displayName = SliderPrimitive.Root.displayName` →
    `Slider.displayName = 'Slider'` (Base UI's d.ts does not type
    `displayName`, though the runtime sets it).
- `apps/desktop/src/renderer/src/components/viewport/LayerScrubber.tsx:26` —
  `onValueChange={(v) => setLayer(v[0])}` → `onValueChange={(v) => setLayer(Array.isArray(v) ? v[0] : v)}`.
  The wrapper's `ComponentPropsWithoutRef<typeof Root>` concretizes the
  generic `Value` at its default, so the callback's value is typed
  `number | readonly number[]`; the array guard keeps the (single-thumb,
  array-valued) call site type-safe. `value={[layer]}`, `min/max/step`,
  `data-testid` pass through unchanged.

Leftover scan clean: `grep -n "radix-ui\|@radix-ui"` on
`ui/slider.tsx` + `viewport/LayerScrubber.tsx` matches nothing.

## Left alone

- `@radix-ui/react-slider` dependency — removed in the final dependency-swap
  commit after the last wrapper.

## Behavior changes

None observed. `onValueCommit` → `onValueCommitted` rename does not apply
(the consumer uses `onValueChange` only); no `inverted` usage anywhere in the
app. Radix's `touch-none` hit area semantics are preserved by moving it onto
`Control`, which is the pointer surface.

## Verify by hand

- Load a sliced model, use the layer scrubber in the viewport overlay: drag
  the thumb to change layers — the thumb must not leave the track at min/max
  (`thumbAlignment="edge"`), and the layer counter updates live.
- Click anywhere on the track to jump; keyboard arrows on the focused thumb.
- Hover/focus states: the ring on focus-visible still renders (no regression
  from the `focus-visible:ring-1` class moving to the Base UI Thumb's div).
