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
existing filament rack in both Prepare and Preview. The lower configuration card
contains the settings and the scope-specific object or plate list. The initial
height split is 35% / 65%;
the divider can be dragged or adjusted with the keyboard. Both panels retain a
minimum height, and the vertical split is session-local.
Window/group height changes preserve the upper Printer + Material panel's pixel
height and let the lower configuration panel absorb the change. Only when the
lower panel's 20% minimum would be violated does the group reduce the upper
panel. Content-driven maximum-height changes and manual divider resizing still
apply independently.
The upper panel's pixel minimum is initialized from 15% of the first visible
group height and capped by its content height. Window resizing does not recalculate
that minimum: changing constraints would re-register the panels and reapply a
percentage split, overriding the intended pixel-preserving behavior.
The filament rack remains mounted while AppShell hides the workspace on other
pages. Prepare → Device → Preview does not remove and recreate Material content;
the combined panel retains its split and section expansion state across navigation.
App keeps the workspace's last Prepare/Preview mode independently of top-level
navigation. Home and Device only hide the mounted workspace; they do not switch
its scene mode, remove action controls, or release the Preview projection and
its layer/text controls. Returning to the same mode preserves those component
instances and local state. Selecting Prepare or Preview still changes the
workspace mode normally.
Preview display controls live in a dedicated right sidebar (initially 320px) with an opaque
card surface and a centered Slice Info header. The sidebar contains the color
scheme selector, compact feature/action visibility rows with eye icons, numeric
color legends, statistics, and current-move inspection. Its content scrolls
independently below the header. The layer and move range sliders remain viewport
overlays. The sidebar follows the retained workspace mode when another page
hides the workspace; Prepare continues to use the full viewport width.
Slice Info and its resize handle remain mounted across Prepare/Preview navigation
and are hidden/inert outside Preview. After the first Preview visit, its valid
projection remains enabled across tab changes, preserving the sidebar's collapse
state, scroll position, color scheme, and visibility settings. Native result
invalidation still replaces stale data; tab navigation alone does not reset it.
Preview display choices also survive reslicing and result invalidation within
the UI session: color scheme, feature/action visibility, travel visibility,
previous-layer dimming, and single-layer mode. New result bounds reset layer/move
positions and result identity independently; a retained single-layer mode starts
with both bounds on the new result's final layer.
The layer range sits at the viewport's left edge, starting 15% down and spanning
54% of its height. A slim 24px dark rounded capsule contains a 6px gray track, teal
selected range, and thin cross-line thumbs. Right-side labels show one-based
layer numbers and native Z heights (two decimal places when available).
Only the layer label corner nearest its handle is square: bottom-left on the
upper label, top-left on the lower label. The other corners have a 6px radius.
Thumb lines are 1px thick with a 1px near-black outline; keyboard focus retains its teal outline.
Their cross-axis span is 22px, so the outline fits within the 24px capsule edge.
The single-layer toggle sits 6px below the left layer capsule as a 24px dark square
button with 3px corners and a layers icon. Multiple-layer mode is its pressed
state and uses a teal icon; single-layer mode is unpressed.
its accessible name, tooltip, and keyboard activation retain the existing toggle behavior.
Single-layer mode displays only the current/end-layer thumb label; range mode
displays both start and end labels.
A matching menu button sits 6px below the single-layer button and opens the
layer options menu to its right. Dim previous layers is a checked menu item
bound to the existing preview state, replacing the standalone sidebar button.
Thumb labels are interactive drag surfaces inside their corresponding slider
thumbs. Pointer events bubble to the native slider drag handling, preserving
the initial grab offset. Labels retain the normal pointer cursor and disable
text selection and touch scrolling during dragging.
The slider control's transparent hit surface extends across the entire capsule,
including side padding and rounded end padding. Clicks and drags anywhere in that
surface use the existing native slider handler and unchanged track coordinates;
the visible dimensions and pointer cursor stay unchanged.
The move range uses the matching 24px horizontal capsule and 6px track at bottom center, spanning 60% of the
viewport with an 8px bottom inset, a thin teal marker, and current move number above it. Drag, wheel,
and keyboard behavior remain unchanged; generic sliders retain their normal style.
Line Type rows show native feature time, its share of the native estimated total,
and filament length/weight when available; absent metrics display a dash.
Those feature statistics are shown once in the table rather than repeated below.
Actions and markers append to the same legend list with their independent
visibility state. A separator and compact icon summary row below that list show
estimated time, combined filament length/weight, and cost. This replaces the
previous labeled Statistics block; current-move inspection remains available below.
The Time, %, and Usage columns use compact 40px, 24px, and 60px widths, with matching header and row alignment.
Feature and action rows use a compact 20px height and share the object list's
2px corners, regular 12px muted labels, and dark button hover surface.
Rows are click-only visibility controls with no selection state or persistent
selection highlight. Visibility is indicated by the eye icon; keyboard focus
remains visible. Scheme color swatches retain
their native colors. Light-muted hover backgrounds are not used for these rows.
The G-code text window renders in the workspace overlay above the viewport and both sidebars. Its drag and resize bounds cover the entire area between the title bar and status bar; saved geometry uses this workspace coordinate space.
The right sidebar's left-edge separator supports horizontal pointer/mouse dragging
and arrow-key resizing between 220px and 560px. Dragging left widens it; dragging
right narrows it. Its independent width is saved as `ui.rightSidebarWidth` in
user preferences after dragging or keyboard resizing, and restored on startup
with the same bounds. An unset width defaults to 320px. It is also retained across
Prepare/Preview and top-level page navigation. The handle is transparent
and shares the existing left-sidebar classes. Both 6px handles overlap the viewport
edge, leaving no visible background strip or hover highlight between the scene
and either sidebar.
The upper card's maximum height tracks the natural height of its printer and
material content, including its border. Content and workspace resize observers
update the limit after slot-count, material-collapse, or available-size changes.
Its minimum height is capped by that content height too, so short content cannot
force empty space. Smaller user-selected heights retain independent scrolling.
Content-size observations synchronously commit the panel constraints before
paint, preventing a transient scrollbar when Material is expanded.

The Material rack uses two columns of compact single-line slots. Each slot
combines a clickable rectangular colour/number block, a searchable preset
selector with a truncated name, and a dropdown chevron. The heading shows the
material count and a collapse toggle; plus and minus buttons add a slot or
remove the last slot. Edit, Merge, and Delete are available by right-clicking a
slot. Existing mutation capabilities and reference-impact confirmations still
control these commands. Mixes, flushing-volume editing, and purge-mode controls
are outside this layout change. Shared buttons use dark hover (`#343437`) and
expanded (`#1B1B1D`)
backgrounds in place of the light muted surface. Material collapse controls,
slot dropdown chevrons, and configuration group headings use these shared
colours; no sidebar-specific button variant is needed. Printer, Process,
filament presets, generic enum options, and object-list filament assignment
selectors share one sidebar dropdown surface: 24px high, 13px regular text,
3px outer corners, no border, a dark base, and a separate 20px square chevron
area. The Select and Combobox trigger variants share these styles; names
truncate within the available width and modified indicators retain their
existing colour. Text and numeric inputs use the same opaque dark control
background (`#1B1B1D`), including configuration search and inline rename fields.
The scalar input and its step buttons share one surface; the inner input stays
transparent in both light and dark CSS states. Focus rings remain visible.
The 2026-10-04 number-stepper styling uses two dark 18px buttons separated by
a 1px gap, with square inner corners and 2px outer corners. Gray plus/minus
icons use heavier strokes with flat ends, matching the supplied reference.
Input-associated buttons share the same dark background and gray foreground
tokens, including Select/Combobox arrows and inline Combobox clear buttons.
Checkboxes use a borderless dark rounded outer square in both states. The
checked indicator occupies 70% of that square, with a teal fill, a fixed 2px
corner radius, and a white checkmark. Focus and disabled behavior are retained.
The Printer preset editor opens from a 24px square settings button to the left
of the selector, using a gray sliders icon and a dark-gray rounded background.
The device/material reference palette is sampled directly from the supplied
image: panel `#27272A`, controls `#1B1B1D`, headers `#171719`, action buttons
`#373739`, dropdown icons `#7D7D7F`, muted labels/icons `#AFAFB0`, white primary
text, and modified indicators `#F7941D`. These use shared theme tokens.
Printer and Material headings use the configuration-mode header design:
full-width dark 20px bars, centered card-colored titles with top-only corners,
and regular 12px text. The Material collapse action remains at the right edge.
Printer has the same right-edge collapse action. Collapsing it hides its
selector and editor button while retaining the title bar and current preset;
the upper panel's content-height constraint follows the collapsed content.
When collapsing content lowers that maximum below the current panel size,
the split is resized immediately to the new limit, returning the freed space
to the configuration panel. Both collapsed headers remain visible.
Before a section toggle changes content, the combined Printer + Material
scroll area's overflow state is captured. If it had
no vertical scrollbar, expanding content also resizes the panel to its new
maximum, subject to the configuration panel's minimum size. A previously
scrolling panel keeps its user-selected split when content expands.

The lower configuration panel uses a full-width dark mode header without a
top divider, with Project, Objects, and Plates tabs (20px high, 12px regular
text, 68px wide). Objects is the renamed Scoped tab. The active
tab has top-only rounding and joins the card surface below. The preset/search row is
followed by horizontal Quality, Strength, Speed, Support, Multi., and Other
page tabs. Tabs do not move down while pressed. Only scopes with multiple
eligible pages display the category tabs. A scope
with one page shows its configuration directly without a category strip. The
strip permits only horizontal scrolling when the sidebar is narrow. Selection is indicated
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
preset selector and Objects displays the object list. Plates displays the plate
list in both Prepare and Preview and edits the active plate's native settings,
independent of any selected objects, parts, or tower. Selecting a plate updates
the configuration target through the existing plate-selection command. Preview
retains its plate-result activation and camera framing behavior.

Objects filters options by the selected object's native scope (or part scope
for a selected model volume). It never falls back to plate settings: an empty
selection prompts the user to select an object or volume. Plate-only options
are confined to Plates; project-level options retain their eligibility rules.
Object and plate lists scroll independently and their bottom edge cannot extend
past the combined list-and-settings panel's vertical midpoint. The height budget
includes the scope header and spacing above the list. The reference area excludes
the Move, Rotate, and Scale panels above it. Resize observations measure the
panel and list offset to update the pixel cap as the panel changes size;
configuration options retain their separate scroll area.
The divider between a list and its settings belongs to the scroll viewport's
border, so it remains fixed while the list contents scroll.
The Plates tab starts with a fixed toolbar: a centered live plate count above
a row containing New Plate, Arrange, and Delete Plate. These are the existing
viewport plate actions, moved out of the bottom-right floating toolbar; native
history receipts, plate limits, arrangement behavior, and painting guards are
preserved. The action row remains outside the list's scrolling area. Send All
and Print All are not introduced by this relocation.
The Objects list inherits its horizontal inset from the configuration panel,
without an additional list-level inset, aligning its edges with other sections.
The Objects list uses compact 24px tree rows beneath full-width dark collapsible
plate headers and an Outside group. Selection uses a subdued teal background;
orange circular-arrow indicators identify native scoped overrides. Part-type
icons distinguish solid and negative volumes. Right-aligned printable controls
and filament-colour cells keep the name column aligned; filament cells show only
the slot number while retaining the assignment menu and inherited-state tooltip.
Object and instance checkboxes use the existing native printable commands and
selection targets. Parts display their inherited object printability without
introducing a separate volume printable setting. Group collapse changes only
the list presentation, preserving native plate membership, selection, drag/drop,
renaming, context menus, the half-panel height cap, and the fixed divider.
The object list stays mounted while hidden so its model-structure and selection subscriptions remain
active. Printer and Process transitions share their existing state and native
preset-selection flow. The horizontal sidebar-width resize and its persisted
preference remain unchanged.

Scoped configuration edits retain valid object/part selections when native
history publishes a stable-ID scene patch. Renderer snapshots carry the full
model replacement generation, so the separate Canvas root prunes deleted IDs
for same-model updates and resets interaction only for a full loader replacement.

Object names also use the orange override colour when that object has local
scoped configuration overrides, independently of selection highlighting.
Object and part circular-arrow markers are buttons that reset all overrides
on that row's native target through the existing history/configuration mutation
queue. They do not change the current selection or reset other selected rows.

Numeric scoped-field steppers use reactive commit-pending state for their
disabled appearance. Both successful and rejected commits release that state,
while a synchronous ref guard continues to prevent duplicate submissions.

Horizontal tab bars respond to mouse-wheel input whenever their list or shared
Tabs root overflows horizontally, including title-bar pages, configuration
categories, and preset-editor pages. Vertical wheel movement scrolls the tab
bar horizontally; trackpad horizontal movement is retained. Non-overflowing
and vertical tab bars leave native scrolling unchanged, and Ctrl-wheel remains
available for zoom. The shared listener covers portal dialogs and is removed
when the app shell unmounts.

## Verification

The 2026-10-04 control, Object List, and tab-wheel follow-up updates the
regressions for the accepted palette, slot-number colour cells, and wrapped
object-row buttons. Numeric field tests cover re-enabling both steppers after
successful and rejected native commits. Wheel tests cover overflowing lists
and parent tab containers, horizontal trackpad input, line-mode deltas, and
preserved zoom/non-overflow/vertical-tab behavior. Electron coverage checks
real tab-bar scrolling, retained scoped selection and orange object names,
and row-specific reset without clearing another object's overrides.

Validation for this follow-up:

- `pnpm test` — 154 files, 1454 tests passed.
- `pnpm typecheck` — all workspace packages passed.
- `pnpm --filter @orca/desktop exec playwright test e2e/scoped-configuration-input.e2e.ts`
  — 2 tests passed, including scoped edit, selection retention, and row reset.
- `pnpm --filter @orca/desktop test:e2e` — renderer build and CSS smoke passed;
  45 tests passed and 12 conditional tests skipped.
- `git diff --check` — passed.
- No native build or real-Web/dual-WASM release matrix is required for these
  shared renderer/style and test changes; no bridge or host adapter changed.

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

The main-CI follow-up adapts the real-project Prime Tower regression to this
layout: select Multi. before checking the tower option, and verify the Material
heading count against rendered filament slots after history restoration. The
Prime Tower history performance test uses the same slot-count check. Native
slot-add capability remains independent of whether the rack is healthy.

Follow-up validation on 2026-10-02:

- `pnpm test` — 138 files, 1291 tests passed.
- `pnpm typecheck` — all workspace packages passed; the desktop typecheck also
  passed after updating both real-project assertions.
- `CI=true pnpm --filter @orca/desktop test:e2e:real` — all six functional
  real-WASM E2E tests passed, including the imported project's tower drag,
  undo/redo, two-plate slicing, G-code exports, and retained-result isolation.
  The runner verified that the canonical project fixture was unchanged.
- `pnpm --filter @orca/desktop exec playwright test e2e/prime-tower-history-performance.e2e.ts`
  with real WASM and a verified temporary fixture copy — 1 test passed;
  canonical fixture identity remained unchanged.
- `git diff --check` — passed. No native rebuild or Web-host E2E was needed
  for these desktop test-only adaptations.

The device-height and Project/Objects/Plates follow-up updates the unit and
host regressions to select the configuration surface explicitly. Current-plate
checks assert the selected list entry and total list count, preserving identity
coverage after the toolbar label became a count. The sidebar regression also
checks the device content-height cap, Preview materials, the plate-list midpoint
limit, and the fixed action row during list scrolling. Painting regressions
expect the relocated actions to remain visible but disabled while editing.

Validation on 2026-10-04:

- `pnpm test` — all workspace unit suites passed.
- `pnpm typecheck` — all workspace packages passed.
- `pnpm --filter @orca/desktop test:e2e` — renderer build and CSS smoke passed;
  45 tests passed, 12 conditional tests skipped.
- `pnpm --filter @orca/desktop exec playwright test e2e/app.e2e.ts e2e/prime-tower.e2e.ts e2e/scoped-configuration-input.e2e.ts --max-failures=2`
  — 34 tests passed, 4 conditional tests skipped.
- `pnpm --filter @orca/desktop exec playwright test --config ../../apps/web/playwright.config.ts web.e2e.ts -g 'multi-plate Prepare grid interactions'`
  — 1 real-Web test passed.
- `pnpm --filter @orca/desktop exec playwright test --config ../../apps/web/playwright.config.ts web.e2e.ts -g 'real printer bed STL|multi-plate Preview'`
  — 2 real-Web tests passed, including retained plate-local Preview results.
- `pnpm --filter @orca/desktop test:e2e:real` — all 10 functional and
  performance tests passed with freshly staged artifacts, including two-plate
  slicing/export, plate switching, Add Plate, and native history restoration.
  The runner verified that the canonical project fixture was unchanged.
- `node scripts/run-arrangement-e2e.mjs --desktop-only` — the serial real-WASM
  arrangement, history, and relocated current-plate entry test passed.
- `pnpm --filter @orca/desktop exec node ../../scripts/run-painting-e2e.mjs`
  — both serial real-WASM painting regressions passed, including disabled
  plate actions during painting and native edits, history, camera, and close.
- `git diff --check` — passed. No native rebuild was needed because no C++,
  bridge, or build-scaffold code changed. Dedicated instrumented profiling and
  the full dual-host/dual-WASM release matrix were not run.

The 2026-10-04 retained-workspace navigation batch was verified with:

- `pnpm test` — 154 files / 1,459 tests passed.
- `pnpm typecheck` — all workspace packages passed.
- `pnpm --filter @orca/desktop exec electron-vite build --mode e2e` and
  `pnpm --filter @orca/desktop exec node scripts/check-renderer-css.mjs`
  — mock renderer build and CSS smoke passed.
- `pnpm --filter @orca/desktop exec playwright test e2e/app.e2e.ts -g 'starts on blank Home|sidebar panels resize independently|full v1 flow'`
  — 3 tests passed. The navigation regression checks the combined panel's
  maximum, scrollbar-free height through Prepare → Device → Preview, mounted
  rack/action/canvas identity while hidden, and Preview → Home → Device → Preview
  without a second mode-change render. The slice/export journey checks retained
  Preview control identity and a non-default layer range through navigation.
- No native rebuild or full release matrix was needed for this shared UI change.

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

Validation for the Preview sidebar and workspace overlay follow-up (2026-10-04):

- Updated component tests to exercise both the relocated Preview sidebar and
  scrubber, with explicit initial-state isolation now that display choices
  survive projection resets. Covered the dimming submenu and single-layer label.
- Added regressions for independent right-sidebar preference normalization,
  restoration and saving, display-option retention across replacement results,
  and G-code dragging bounded by the full workspace above the sidebars.
- Updated Electron selectors to distinguish the left sidebar from the retained
  right sidebar, and checked the slim scrubber thumbs and inverted multi-layer
  toggle state. The Preview journey proves workspace-wide G-code drag bounds
  and hit-testing over the right sidebar.
- `pnpm test` — 154 files and 1464 tests passed across all workspace packages.
- `pnpm typecheck` — all workspace packages passed.
- `node scripts/stage.mjs --soft`,
  `pnpm --filter @orca/desktop exec electron-vite build --mode e2e`, and
  `node apps/desktop/scripts/check-renderer-css.mjs` — passed.
- `pnpm --filter @orca/desktop exec playwright test e2e/app.e2e.ts e2e/select-scroll.e2e.ts --grep 'full v1 flow|preview overlay|select|sidebar panels resize|starts on blank Home'`
  — 14 Electron mock tests passed.
- `git diff --check` — passed. Real-WASM builds and the dual-host release matrix
  were not run: this follow-up changes shared UI and preference handling only.