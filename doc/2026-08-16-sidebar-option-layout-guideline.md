# Sidebar options: label and value on the same line

Date: 2026-08-16. Bounded UI change; design guideline for the settings sidebar.

## Guideline

Sidebar options put the **label and the value control on the same line** to
save vertical space. A stacked label-above-control layout is only acceptable
where the control cannot share a row (none today).

## What changed

- `OptionField.tsx` — `enum` and numeric/text rows were stacked
  (`space-y-1`: label, then full-width control). They now use the same
  `flex items-center gap-2 py-1` row the `bool` rows already used, per the
  guideline:
  - Fixed `w-32` label column (`truncate` + `title` for long names) — the
    fixed column keeps every value control vertically aligned at one x.
  - Value controls are `flex-1` and fill the rest of the row: `Input`
    (values left-aligned), `SelectTrigger`, and the bool `Checkbox`.
  - Verified at default (288px) and minimum (220px) sidebar widths: value
    column stays at one x; controls shrink, labels never truncate with
    current presets.
- Preset rows (Printer/Process/Filament) stay stacked by user decision —
  they are selection pickers with search, not value options.

## Layout notes

- Sidebar min width is 220px (see `doc/2026-08-15-resizable-sidebar.md`);
  at that width the label truncates before the control shrinks.
- Matching precedent: the `bool` rows were already inline; this change makes
  every option row conform.
