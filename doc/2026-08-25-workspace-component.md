# 2026-08-25 — Workspace component (sidebar + 3D scene)

## Why

`AppShell` had grown two unrelated jobs: stacking the four app rows
(title bar / toolbar / content / status) and owning the whole sidebar↔scene
split — ~110 lines of drag, keyboard, and preference-persistence logic for a
divider that only concerns the middle row.

The scene interaction controller was split across the same seam from the other
side: `App` held the `sceneInteraction` state purely so it could hand the
controller to the sidebar (`ObjectList`, `SettingsPanel`) and the viewport,
which are siblings inside that middle row. Every controller change re-rendered
`App`, though nothing in `App`'s own render depends on it.

## What changed

- **New** `packages/slicer-app/src/components/workspace/Workspace.tsx`
  - Owns the sidebar width state, the resize separator (pointer/mouse/keyboard)
    and the `220px`–`560px` clamp + preference persistence — moved verbatim
    from `AppShell`, including the `data-testid="sidebar-resizer"` contract.
  - Owns the `SceneInteractionController` state and renders both halves that
    consume it: the sidebar (`ObjectList` + `SettingsPanel`) and `Viewport`.
  - Optional `onSceneInteractionChange` prop hands the controller upward.
- `packages/slicer-app/src/components/layout/AppShell.tsx`
  - Now a pure vertical stack (170 → 19 lines). The `settings` and `viewport`
    props collapse into one `workspace` node, which must stretch itself
    (`flex-1 min-h-0`).
- `packages/slicer-app/src/App.tsx`
  - Drops the `sceneInteraction` state and the three child imports; keeps a
    ref, fed by a stable `onSceneInteractionChange` callback, because the menu
    command dispatcher (`addModel`, `clearScene`) reads the controller lazily
    at dispatch time.
  - Menu command actions and the app-level toolbar imports now come from
    `components/workspace/actions/` (`sceneActions`, `sliceActions`).
- `packages/slicer-app/src/components/workspace/` is now the home of the
  whole scene-facing tree: `Workspace.tsx` plus `viewport/`, `objectList/`,
  `settings/`, and `actions/` — the former `components/toolbar/` command
  modules (`sceneActions`, `sliceActions`, `deleteSelection`,
  `persistModelTransforms`, `syncModelTransforms`, and their tests) moved
  there. `Toolbar.tsx` and `StatusBar.tsx` (from `components/status/`) moved
  into `components/layout/` alongside `AppShell` and `TitleBar`;
  `components/toolbar/` and `components/status/` no longer exist.
  `Toolbar.tsx` imports its actions from `workspace/actions/`.

## Behavior

The sidebar contains two vertically resizable cards. The upper card scrolls
its device/material content; the lower card scrolls only the configuration
options below the category tabs. Mode, preset, search, and category controls
remain fixed above that scroll area. Configuration content has an additional
4px gap before the scrollbar only while it overflows vertically. Without a
scrollbar the content retains its full width and aligns with the header. Both
panel size and content-height changes update this overflow state. Shared
scrollbars use a 6px dark track, a rounded dark-gray thumb, and no arrow
buttons, matching the reference sidebar. Chromium uses the custom scrollbar
pseudo-elements; other browsers retain the thin standard-property fallback.
The upper device/material card contains the Printer selector and the
existing Prepare-tab filament rack. The lower configuration card contains the
settings and, in Preview, the plate list. The initial height split is 35% / 65%;
the divider can be dragged or adjusted with the keyboard. Both panels retain a
minimum height, and the vertical split is session-local.

The Material rack uses two columns of compact single-line slots. Each slot
combines a clickable rectangular colour/number block, a searchable preset
selector with a truncated name, and a dropdown chevron. The heading shows the
material count and a collapse toggle; plus and minus buttons add a slot or
remove the last slot. Edit, Merge, and Delete are available by right-clicking a
slot. Existing mutation capabilities and reference-impact confirmations still
control these commands. Mixes, flushing-volume editing, and purge-mode controls
are outside this layout change. Shared buttons use dark hover (`#343437`) and
expanded (`#1D1D1F`)
backgrounds in place of the light muted surface. Material collapse controls,
slot dropdown chevrons, and configuration group headings use these shared
colours; no sidebar-specific button variant is needed. Printer, Process,
filament presets, generic enum options, and object-list filament assignment
selectors share one sidebar dropdown surface: 24px high, 13px regular text,
3px outer corners, no border, a dark base, and a separate 20px square chevron
area. The Select and Combobox trigger variants share these styles; names
truncate within the available width and modified indicators retain their
existing colour. Text and numeric inputs use the same opaque dark control
background (`#1D1D1F`), including configuration search and inline rename fields.
The scalar input and its step buttons share one surface; the inner input stays
transparent in both light and dark CSS states. Focus rings remain visible.

The lower configuration panel uses a full-width dark mode header without a
top divider, with compact 20px tabs (12px regular text, 68px wide). The active
tab has top-only rounding and joins the card surface below. The preset/search row is
followed by horizontal Quality, Strength, Speed, Support, Multi., and Other
page tabs. Tabs do not move down while pressed, and the category strip permits
only horizontal scrolling when the sidebar is narrow. Selection is indicated
by an underline; orange text marks only
local modifications. A shared TypeScript layout preserves the pinned Orca Print tab's
page/group/option ordering without altering native scope eligibility. Eligible
options absent from that layout remain in Other. Search covers all pages;
group headings collapse, and rows align labels, reset icons, and controls.
Category tabs, group headings, subsection headings, and parameter labels share
a 4px horizontal text inset; heading buttons have no border offset.
Numeric minus/plus buttons submit through the existing mutation command;
checkboxes and selects use the same compact 24px control rhythm. Native category
reset is available by right-clicking a group heading; field and target-wide
reset commands retain their original behavior.

Immediately below the configuration scope toggle, Project displays the Process
preset selector and Scoped displays the object list. The object list stays
mounted while hidden so its model-structure and selection subscriptions remain
active. Printer and Process transitions share their existing state and native
preset-selection flow. The horizontal sidebar-width resize and its persisted
preference remain unchanged.

## Verification

The 2026-10-02 sidebar and filament-slot batch was verified after the user's
request to run the affected tests and commit:

- `pnpm test` — 138 files, 1291 tests passed, including application boundaries.
- `pnpm typecheck` — all workspace packages passed.
- `pnpm --filter @orca/desktop test:e2e` — renderer build and CSS smoke passed;
  44 tests passed, 11 conditional tests skipped. The new sidebar regression
  covers pointer/keyboard resizing, Project/Scoped content visibility, fixed
  header scrolling, conditional scrollbar spacing, pressed-tab alignment,
  compact dropdown styling, and input backgrounds.
- `pnpm --filter @orca/desktop exec playwright test e2e/scoped-configuration-input.e2e.ts`
  — 2 tests passed, covering modified indicators, native-category reset,
  mixed-value edits, percentage commits, and Escape cancellation. The mock's
  history receipt replaces scene buffers; the test waits for publication and
  reselects the target before checking persisted values and sources.
- `pnpm --filter @orca/slicer-app exec vitest run src/components/workspace/Workspace.test.tsx`
  — 10 tests passed after the final resizer identifier adjustment.
- `git diff --check` — passed. No native WASM build, real-WASM acceptance run,
  or Web-host e2e was run for this shared UI batch.

The following historical results apply to the original workspace extraction:

- `pnpm typecheck`, `pnpm test` (282 unit tests, incl. the slicer-app
  import-direction guard) — pass.
- `pnpm --filter @orca/desktop test:e2e` — 17 passed, 2 skipped, 1 failed.
  The failure (`scene selection: rotate/scale gizmos, panels, coord toggle`,
  gizmo axis polls `null`) reproduces identically on the unmodified baseline
  and is **pre-existing**, not caused by this refactor.
- `apps/desktop/e2e/preferences-persistence.e2e.ts` — passes. It is not in the
  default `test:e2e` list but is the test that covers the moved resizer, so it
  was run explicitly.
- No WASM quick build: this change touches no C++, bridge, or build scaffold.
