# select

2026-08-16 — transformation engine (legacy `default` style, no golden
replay), anatomy checked against `@base-ui/react@1.7.0` d.ts and the live
base registry select; verdict: migrated, one flagged behavior delta.

## Changed

- `apps/desktop/src/renderer/src/components/ui/select.tsx` —
  - Import: `@radix-ui/react-select` → `import { Select as SelectPrimitive } from '@base-ui/react/select'`.
  - `Select` / `SelectValue` stay bare re-exports of `Root` / `Value`
    (Base UI `Value` renders the value string; all call sites use
    value === label, so no `items` prop is needed — verified per call site).
  - `SelectTrigger`: unchanged classes; `SelectPrimitive.Icon asChild` →
    `SelectPrimitive.Icon render={<ChevronDown … />}`.
  - `SelectContent`: `Portal > Content` → `Portal > Positioner > Popup`.
    - Radix `position="popper"` prop dropped; wrapper now exposes the
      `Positioner.Props` Pick (`align`, `alignOffset`, `alignItemWithTrigger`,
      `side`, `sideOffset`) per the skill's declare→destructure→forward rule,
      defaults `align='center'`, `sideOffset=4` (the base-registry defaults;
      `sideOffset=4` restores the old 4px gap that the radix
      `data-[side=bottom]:translate-y-1` hack provided, so that class is
      gone and the gap is done by Base UI positioning).
    - Positioner gets `isolate z-50`; Popup keeps the old `relative z-50`
      (→ `relative isolate z-50`) plus the user's exact surface classes
      `max-h-96 min-w-[8rem] overflow-hidden rounded-md border bg-card
      text-card-foreground shadow-md`.
    - `Viewport` → `List`, keeping the user's `p-1` class.
    - Animation restated per the skill's class-mapping (no 1:1 translate of
      `data-[state=open]:animate-in`): `transition-[opacity,scale]
      data-starting-style:opacity-0 data-starting-style:scale-[0.97]
      data-ending-style:opacity-0 data-ending-style:scale-[0.97]` — matches
      the project's custom enter/exit keyframes intent (fade + 0.97 scale)
      using Base UI's deferred-unmount hooks.
  - `SelectItem`: classes unchanged; `ItemIndicator` child → `render`
    (`render={<Check className="h-4 w-4" />}`) inside the same
    `absolute right-2` span wrapper.
  - displayNames hardcoded (`'SelectTrigger'`/`'SelectContent'`/`'SelectItem'`)
    — Base UI's d.ts does not type `displayName`.
- `apps/desktop/src/renderer/src/components/settings/OptionField.tsx:31` —
  `onValueChange={(v) => setValue(optionKey, v)}` →
  `(v) => v != null && setValue(optionKey, v)` (Base UI widens the value to
  `Value | null`; the store's `setValue` takes `string`).
- `apps/desktop/src/renderer/src/components/settings/SettingsPanel.tsx:97` —
  `onValueChange={onValue}` → `onValueChange={(v) => v != null && onValue(v)}`
  (same widening). `value={value || undefined}` is still valid — Base UI's
  `value` accepts `| null | undefined`.

Leftover scan clean: `grep -n "radix-ui\|@radix-ui"` on `ui/select.tsx` +
both settings consumers matches nothing.

## Left alone

- `@radix-ui/react-select` dependency — removed in the final dependency-swap
  commit.
- The "Not installed" group header is a plain `div` inside `SelectContent` —
  untouched (works under both primitives; Base UI List accepts arbitrary
  children).
- `max-h-96 overflow-hidden` (no scrollbar) kept as-is — that was the radix
  version's behavior for long lists too (the stock registry uses
  `overflow-y-auto`; the user's build clips instead). Pre-existing quirk,
  preserved.

## Behavior changes

- FLAGGED — default popup alignment: the radix wrapper defaulted
  `position="popper"`; the Base UI wrapper defaults `alignItemWithTrigger`
  (item-aligned, the shadcn base-registry default). The popup now aligns to
  the selected item instead of the trigger edge. Visual result is the modern
  select behavior; call sites never passed `position`, so no explicit
  `alignItemWithTrigger={false}` was needed. `sideOffset=4` keeps the
  breathing room.
- The enter/exit animation is transition-based (starting/ending styles)
  instead of keyframe-based (`animate-in`/`animate-out`). Same fade+scale
  intent; exit animation relies on Base UI's deferred unmount.

## Verify by hand

- Settings panel preset selects (Printer/Process/Filament): open each —
  popup appears near the selected item, keyboard ↑/↓ moves the highlight,
  typeahead still works, Enter selects and the trigger text updates.
- `data-testid="preset-select"` still reachable (e2e exercises it).
- Enum option selects in the Process section: select a value, the store
  value updates; placeholder shows for an empty select.
- Close via Escape / click-outside; focus returns to the trigger.
- Disabled items in the "Not installed" group render dimmed and unselectable.
