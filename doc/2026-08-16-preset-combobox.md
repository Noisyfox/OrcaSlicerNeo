# Preset pickers become searchable comboboxes

Date: 2026-08-16. Bounded UI change; supersedes the plain Select in the
Presets section of the settings panel.

## What changed

- New `apps/desktop/src/renderer/src/components/ui/combobox.tsx` — shadcn/base-ui
  wrapper in the same style as `select.tsx` (same data-slot names, popup/item
  classes, lucide icons). Exports: `Combobox`, `ComboboxInput` (the select-look
  trigger with a real text input + chevron button), `ComboboxContent`, `ComboboxList`,
  `ComboboxItem`, `ComboboxEmpty`, plus Group/Label/Separator/Trigger/Value.
- `SettingsPanel.tsx` `PresetRow` (Printer/Process/Filament) now renders the
  combobox. Typing filters case-insensitively; arrow keys/Enter/Esc come free
  from the primitive.
- Per user decision, **uninstalled (`is_visible: false`) presets are no longer
  rendered at all** — the dimmed "Not installed" group is gone. The visibility
  flag still comes from the bridge (`set_visible_from_appconfig`), never
  client-side logic.
- `data-testid="preset-select"` kept on the Printer row's input — the e2e
  suite's visibility assertions depend on it.

## Base UI 1.7 gotcha: children are NOT auto-filtered

The shadcn registry's combobox (base-mira) targets a newer Base UI. In
`@base-ui/react@1.7.0`, filtering only runs through the **items-prop pipeline**:

- `<Combobox.Root items={...}>` — the root derives `filteredItems` from the
  query; `filter` defaults to an Intl.Collator case-insensitive substring match.
- Statically rendered `<ComboboxItem>` children are never hidden, and
  `data-empty` on the popup is derived from `filteredItems` — so without the
  `items` prop the empty state fires spuriously.
- The working pattern: pass `items` on the Root and give `ComboboxList` a
  **function child** — the list implicitly wraps it in `Combobox.Collection`,
  which maps the root's filtered items (`itemsToRender.map(children)`).

Without this, typing narrows nothing — the symptom that cost the debugging
time here.

## Notes / behavior

- Esc or outside-press without a selection leaves the typed query in the input
  (base-ui single-mode behavior — `closeQuery` keeps the list filtered during
  exit animation; the input value is not restored). The store selection is
  authoritative and unchanged.
- A selection that is not in the visible list still displays its raw name in
  the input (`itemToStringLabel` = the string value).
- Selection still round-trips through `selectPreset` → `setSelections` →
  `getAppConfig` → `appConfig.save` exactly as before.

## Preset dirty-state display (2026-10-10)

Neo displays dirty state through orange highlighting without `*` or
`(modified)` in any preset selector. The shared bridge display projection uses
the native alias, falling back to the full name, for Printer, Process,
Filament, projected Process source rows, and filament slots. It preserves
native dirty flags, preset identity, imported values, and scoped overrides.
Process highlighting uses resettable project overrides; Printer and Filament
highlighting use draft overlays. This is Neo's presentation policy; Orca's GUI
initializes its native textual dirty marker to `* `.

The existing native project-preset history harness covers both embedded-child
save/reopen and direct system-Process difference import. The latter reproduced
the decorated label on the original artifact. It checks the unchanged source
label and that the saved layer-height override remains effective and scoped.
Embedded-child reopening still checks its source-row projection. The draft
registry harness also checks clean Printer/Filament labels and filament-slot
labels while the existing modified-source assertions remain active.

Verification passed: `pnpm test` (1,837 passed, 3 existing skips),
`pnpm typecheck`, dual-variant `scripts\build-windows.bat quick -j 4`,
`native-project-preset-history-smoke.mjs` and
`preset-draft-registry-smoke.mjs` on both variants, serial
`bridge-smoke.mjs` with `fixtures/cube.stl`, and mock Electron
`project-lifecycle.e2e.ts -g "Electron picker"`. Both variants were staged
with `pnpm stage:assets`; `git diff --check` passed. Full real-host release
qualification was not run for this focused label correction.

A locally supplied 3MF was also loaded through the real threaded WASM: its
Process alias was undecorated, all 14 objects loaded, and 12 effective Process
overrides remained in scoped configuration. The private archive was not added
to the repository. The first full unit run timed out in the existing profile
packaging test during native compilation; the rerun after compilation passed.
