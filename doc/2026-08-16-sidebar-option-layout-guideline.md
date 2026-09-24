# Sidebar options: label and value on the same line

Date: 2026-08-16. Bounded UI change; design guideline for the settings sidebar.

## Guideline

Sidebar options put the **label and the value control on the same line** to
save vertical space. A stacked label-above-control layout is only acceptable
where the control cannot share a row (none today).

## Current implementation

- Project/Scoped option rows are rendered by `ScopedConfigurationPanel.tsx`.
  Their fixed `w-32` label column keeps the value controls aligned; controls
  flex into the remaining width.
- Preset rows remain stacked because they are selection pickers with search,
  not option-value rows.

## Layout notes

- Sidebar min width is 220px (see `doc/2026-08-15-resizable-sidebar.md`);
  at that width the label truncates before the control shrinks.
- Boolean, enum, and numeric/text rows follow the same inline layout.
