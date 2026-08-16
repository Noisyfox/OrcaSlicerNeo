# label

2026-08-16 — transformation engine (legacy `default` style, no golden replay); verdict: migrated, no primitive.

Radix `@radix-ui/react-label` has **no Base UI counterpart** (per the migration
reference: "Label -> native `<label>`"). The wrapper was rewritten as a plain
native `<label>` with forwardRef; all original classes preserved verbatim.

## Changed

- `apps/desktop/src/renderer/src/components/ui/label.tsx` — `LabelPrimitive.Root`
  replaced with `<label>`; `React.ElementRef<typeof LabelPrimitive.Root>` /
  `React.ComponentPropsWithoutRef<...>` become `React.ElementRef<'label'>` /
  `React.ComponentProps<'label'>`; `displayName` set to `'Label'` (previously
  copied from the primitive). Class string untouched:
  `text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70`.
  No `@base-ui/react` import is needed for this component.
- Consumers repointed (progressive flow, one at a time, typecheck after each,
  imports flipped back after the rename): `settings/OptionField.tsx:4`,
  `settings/SettingsPanel.tsx:8`, `viewport/LayerScrubber.tsx:4` — import
  path only, zero prop changes (`htmlFor`, `className` are native label props).

Leftover scan clean: `grep -n "radix-ui\|@radix-ui"` on this component's
files matches nothing.

## Left alone

- `@radix-ui/react-label` dependency — removed in the final dependency-swap
  commit after the last wrapper (radix stays installed until then).

## Behavior changes

None. Native `<label>` matches the Radix root's behavior (htmlFor association,
peer-disabled styling, default font inheritance).

## Verify by hand

- Settings panel: clicking a label like "Wall loops" focuses its input; the
  checkbox labels in the options list toggle the checkbox when clicked.
- Layer scrubber label renders with muted styling in the overlay.
