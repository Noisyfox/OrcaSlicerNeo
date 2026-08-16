# base-mira UI conformance migration

Date: 2026-08-16

## What

Migrated every UI component in `apps/desktop/src/renderer/src/components/ui/`
to full conformance with the official shadcn **base-mira** registry
(style base-mira, Base UI primitives): button, checkbox, combobox, input,
input-group (new), label, progress, select, slider. The settings panel
adopted base-mira sizing (e.g. `size-3` 12px slider grabber, `h-7` default
controls), and the preset picker moved to the official **popup-style**
combobox (button trigger showing the current value, search input inside
the popup, `showTrigger={false}`) per
<https://ui.shadcn.com/docs/components/base/combobox#popup>.

Three real bugs surfaced while migrating/verifying. All three are fixed,
with root causes below. Verification: `vitest` (9/9) + the full Playwright
e2e (mock mode) green, including a regression test for the slider grabber.

## Bug 1 — popup never unmounts after close (combobox/select)

Symptom: the combobox popup stayed mounted after an item pick, frozen with
`data-closed` + `data-ending-style`; the e2e "popup dismisses on pick"
assertion hung.

Root causes (three, compounding):

1. **Stuck var transitions.** The official popup classes include
   `duration-100`, which compiles to `transition-property: all`. The
   positioner rewrites `--available-height` / `--transform-origin` /
   `--anchor-width` on the popup element; with `transition-property: all`
   those custom-property writes spawn transitions that never advance
   (`pending` at t=0). Base UI's `useAnimationsFinished` waits on
   `getAnimations().finished`, so the popup never unmounts. Fix:
   `transition-none` on `ComboboxContent`/`SelectContent` (open/close
   motion is the animation alone).
2. **Transform-animating keyframes.** Our custom `animate-in`/`animate-out`
   keyframes animated `transform: translateY(4px) scale(0.97)` (ported from
   tailwindcss-animate, which is tw3-only). The positioner positions the
   popup with an **inline** transform; the animation overrode it, breaking
   anchoring mid-animation and feeding the positioner's reposition loop
   (data-side flips every ~50ms, `--available-height` swinging 615→255→…).
   Fix: `@keyframes enter/exit` animate **opacity only** (`index.css`).
3. **In-popup trigger overwrites the anchor.** The combobox input's default
   chevron `ComboboxTrigger` renders *inside* the popup; base-ui's trigger
   registers itself as `store.triggerElement`, so the positioner anchored
   to a 24px chevron *inside* the popup — a circular dependency with
   runaway oscillation. The official demo uses `showTrigger={false}` (the
   only trigger is the root button). Fix: `showTrigger={false}` in
   `PresetRow`.

## Bug 2 — layer-scrubber invisible after slice (slider)

Symptom: e2e `getByTestId('layer-scrubber')` resolved but Playwright
reported hidden. Dump showed the slider root at 359×0: the track's
`h-1` had never applied.

Root cause: **Tailwind v4.3 does not compile the un-bracketed data-variant
value form.** `data-orientation=horizontal:h-1` silently generates no
CSS — only `data-name:` (boolean) and `data-[name=value]:` (bracketed)
forms compile. The a2b6344 "restore thumb" fix switched the official
`data-horizontal:` classes (which match an attribute base-ui doesn't emit)
to the `data-orientation=…:` form, which is equally dead: the track
collapsed to 0px and the knob floated on an invisible bar. The e2e had
not been run since that commit. Fix: bracketed form
`data-[orientation=horizontal]:h-1` etc. on Root/Control/Track/Indicator
(all five slider parts emit `data-orientation="horizontal|vertical"` in
Base UI 1.7).

**Rule for this repo:** data-value variants must use the bracketed form
`data-[name=value]:`. The un-bracketed `data-name=value:` shorthand does
not exist in Tailwind v4.3 and fails silently — check the built CSS for
the class before trusting it.

## Bug 3 — slider thumb clipped (fixed in a2b6344, regression test added)

The Base UI migration had nested the Thumb inside the `overflow-hidden`
Track, clipping the 12px knob to the 4px band. The e2e now probes
hit-testing (`elementFromPoint`) at the thumb's vertical extremes, which
`getBoundingClientRect` can't detect.
