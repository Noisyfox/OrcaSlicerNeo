# Application Shell

**Updated:** 2026-10-11
**Status:** Delivered behavior
**Scope:** Shared layout, desktop window chrome, menus and diagnostics.

## Host and page lifetime

The application lives in `packages/slicer-app`; hosts inject platform services
under the [shared architecture](Web-Electron%20Shared%20Application%20Architecture.md).
Home, Prepare, Preview and Device remain mounted while the application is ready.
Inactive pages are hidden and inaccessible, preserving their expensive state.
The complete desktop layout is retained at any window size: settings and the
3D viewport shrink to fit and scroll internally when constrained. Do not impose
a fixed minimum viewport or claim partial responsive/mobile support; mobile
product support remains deferred.

Electron uses a hidden native titlebar. Windows/Linux retain native overlay
window controls; macOS retains traffic lights and its native application menu.
Interactive renderer controls are excluded from drag regions. Closing the last
window quits Electron on all platforms after the project-close guard succeeds.
The packaged renderer uses a guarded loopback HTTP origin; Electron WASM runs
in the utility process, as specified by
[Native Python Plugin Architecture](Native%20Python%20Plugin%20Architecture.md).

## Titlebar and menus

One 32px titlebar contains the application menu, Save Project, Undo, Redo,
Home/Prepare/Preview/Device tabs and the project name/dirty marker. Web and
Windows/Linux use a left hamburger with File/Help submenus. macOS uses the
native menu and reserves the traffic-light inset. Web has no Quit/Exit item.

Quick actions are icon-only, with 28px hit areas and 16px icons. Tabs use 27px
surfaces flush with the bottom edge, rounded top corners and a gray selected
surface. Home is icon-only. Narrow navigation scrolls without changing the
titlebar height and hides its scrollbar to preserve the centerline. Quick-action
contents, page-tab contents, and the project name share y=18.5px in the 32px
bar; quick actions and the project name have a 2.5px downward content offset.
Tabs have 12px horizontal padding, a 10px icon/text gap, and 13px text with a
20px line height, also used by the project name. The selected surface is
`#54545A`; the shell shares its `titlebar-tab` token. Undo/Redo left-click performs
one action; right-click opens the corresponding directional history list.

Vertical separators follow the hamburger and both sides of the page-tab group.
Style the installed Base UI separator via `data-orientation`. The divider before
Home has no right margin and the divider after Device has no left margin; tab
padding supplies that clearance, with 12px after the latter divider before the
project name. Selecting Home hides the group's left divider; selecting Device
hides its right divider. Hidden dividers retain their space. Every divider,
including those between inactive tabs, is 1px wide, 20px high, with fully opaque
border colour.

Rendered and native menus consume the same versioned model and complete state
snapshot. Dispatch rechecks availability, including startup, modal setup,
project operations, painting, export and slice state. Invalid native snapshots
fall back to disabled state. Slicer progress is normalized from 0–100 to 0–1
at the menu projection boundary. Source opening is a fixed allowlisted host
operation; arbitrary URLs are not accepted by that command. Once its menu
surface exists, Help Source remains enabled through startup and failure rather
than depending on slicer readiness. The modal Setup Wizard's command block still
applies while it owns the workspace. Publish the model and complete state from
one app-boundary subscription, register commands once,
and begin with startup-disabled state. On failure publish failed state; on
unmount stop publication and ignore late completions. Activate and dispose the
dispatcher together with the native-command subscription, so StrictMode effect
replay cannot leave a subscribed dispatcher disabled. Windows/Linux must not
install a competing native File/Help menu. Real packaged macOS verification
is required for traffic-light insets, menu ownership, availability transitions,
window dragging, Quit and source opening; a mock browser is insufficient.

## Workspace and controls

The shared Workspace owns the sidebar/viewport split. Sidebar width defaults
to 288px, clamps to 220–560px and persists through `ui.sidebarWidth`. Dragging
continues outside the separator; ArrowLeft/ArrowRight adjust by 16px. The
transparent 6px separator overlays the canvas without hover/focus fill.

The canvas meets the titlebar, window edge, sidebar and status bar. Floating
controls retain a frame inset of 4px top/right and 6px left. There is no separate
top toolbar row. Plate actions live in the Plates sidebar tab. The teal split action at
top-left offers Slice until a result exists, then Export, Send or Send & Print
according to its selector. The selector defaults to Export and opens downward.
The two rounded halves have a 2px gap and no enclosing panel. During slicing,
the main half shows actual percentage; the spinner square becomes a red Cancel
control on hover/focus when threaded cancellation is available; serial slicing
does not offer cancellation. Cancellation waits for the runtime terminal and never
publishes a cancelled result. Per-plate execution and serial/threaded limits
remain governed by [Per-Plate Print Architecture](Per-Plate%20Print%20Architecture.md).

Settings labels and value controls share a row unless a complex field requires
more space. Preset selectors are searchable popup comboboxes. Shared UI uses
the project's Base UI/shadcn wrappers. Select popups anchor below their trigger
(`alignItemWithTrigger=false`) and track scrolling; the normal modal backdrop
remains. Popup opacity animation must not replace positioning transforms or
leave transitions pending. Tailwind attribute-value variants use bracketed
`data-[name=value]` syntax, and slider thumbs stay outside clipped tracks.

### Preset labels and sidebar layout

Option rows reserve a fixed `w-32` label column and let the value control grow;
at minimum sidebar width truncate the label before squeezing its control.
Preset rows intentionally stack their label and searchable selector.

Comboboxes use the shared Base UI items/filter contract and function-child
rendering with case-insensitive search. Only installed, visible native
candidates appear; native compatibility and availability remain authoritative.
Clean display labels use the native alias, falling back to the full native
name. This also applies to projected Process sources and filament-slot labels.
A project Print child keeps its command/storage/history identity while showing
its native source identity; presentation never replaces the child with the
native edited preset.

Modified selectors use orange highlighting only: no `*` or `(modified)` suffix
is added. Process markers reflect resettable project overrides; Printer and
Filament markers reflect nonempty native source drafts. See
[Preset Editor Dialog](Preset%20Editor%20Dialog.md) for the source-sharing and
reset rules. Choice labels and swatch colours are not rewritten by dirty state.

### Shared CSS ownership

Each host's stylesheet imports `tailwindcss` and then
`@orca/slicer-app/styles.css`; the host entry imports only its own stylesheet.
Each host runs `@tailwindcss/vite`. The shared stylesheet contains ordinary CSS
and directives, with `@source` paths relative to that file. The CSS subpath is
an explicit package export: do not swallow it with a package-wide Vite alias
or `@orca/slicer-app/*` TypeScript alias. No TypeScript companion, CSS declaration
shim or `allowArbitraryExtensions` workaround is required. Verify generated
CSS, since unprocessed source directives can be silently ignored.

## Detailed workspace presentation

### Shared control sizes and dropdowns

The Add Part, Negative Part, Modifier, Support Blocker, and Support Enforcer submenus
share the Add Primitive menu's shape icons. Their Load entry also uses the scene's Add
Model folder icon.

The Change Filament context submenu and object-list filament selector show each slot's
current effective colour as a bordered swatch before its `N - filament name` label,
using its slot number and current preset name. Both the scene and object-list menus
share this rendering. The part's Default entry has no colour swatch, matching Orca's
unassigned entry. The compact object-list selector trigger continues to show only its
slot number on the slot colour background. All shared Select and Combobox dropdowns size
to their widest visible item, reserving room for the selected-item checkmark and
remaining bounded by the window width. This includes printer, bed-type, process/filament
preset, and configuration option dropdowns. Dropdowns are at least as wide as their
closed trigger, with a 128px minimum; longer options expand the popup beyond that width.
Select popups clip an inner scrolling list to their rounded outer surface, so the native
scrollbar stays visible inside the popup corners. Select scroll-arrow controls are
omitted because Base UI hides the scrollbar when those controls are present; Combobox
popups use the same outer clipping structure and retain a visible native scrollbar when
their option list overflows, including preset selectors.

Shared controls and labels use 13px text, including compact buttons and sidebar list
rows. Module tabs, sidebar section headers, and parameter group titles use 11px text.
The app titlebar tabs retain their existing 13px size. Plate-card statistics use tight
line spacing so their 13px text stays fully visible within the fixed card height. These
sizes share theme tokens across both hosts.

### Tool cards

The Prepare scene gizmo toolbar is a vertical opaque card at the viewport's left edge.
Arrange, Move, Rotate, Scale, and painting options are shown in an adjacent card to its
right instead of inside the settings sidebar or at the viewport's right edge. Both cards
are centered within a shared region beginning 56px below the viewport controls frame and
ending 176px above its bottom, reserving space for the 3D navigator. Each card scrolls
independently on short windows. The existing tool order and actions are retained, with a
horizontal separator after Add Model. Empty space in the shared region passes pointer
input to the scene. Arrange uses the same inline options card instead of a popover; its
toolbar button toggles the card, choosing another tool immediately closes it, and
starting arrangement closes it. Pressing the 3D scene canvas also closes Arrange without
consuming the scene gesture; interacting inside its options card keeps it open. Opening
Arrange closes the armed transform gizmo and first awaits a successful close of any
active painting session; unfinished painting operations continue to block switching.

### Sidebar split and lifetime

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
### Preview presentation

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
Feature and action rows share the object list's 2px corners and dark button
hover surface; their current compact typography is defined below.
Statistics are rendered only by the sidebar table and compact footer; the inspection
panel contains current-move details with no legacy statistics-layout switches.
Rows are click-only visibility controls with no selection state or persistent
selection highlight. Visibility is indicated by the eye icon; keyboard focus
remains visible. Scheme color swatches retain
their native colors. Light-muted hover backgrounds are not used for these rows.
Slice Info categorical legends follow Orca libvgcode: feature roles and used filament
tools are collected only from Extrude moves (native move type 10), sorted by native ID.
Travel and action/marker rows are shown only when their move type is present in the
current result. The full result determines presence, independently of current layer
bounds and visibility switches. Native preview analysis also publishes move statistics
for Travel, Retract, Unretract, Wipe, Seams, and Tool changes. It sums normal-mode move
times and counts, excluding internal-only moves. Retract/Unretract distance sums
absolute E-axis deltas; other distances sum processed travel distances. Travel uses the
processor total distance/count; Seams prefers the seam gap plus scarf distance; Tool
changes use total filament load, unload, and tool-change delay. Feature time only
includes Extrude moves. The typed client maps these statistics through the shared
runtime result into Slice Info. In Feature mode, action rows display time, percentage of
total estimated time, and distance/count Usage. Distances use rounded mm below 1000mm
and two-decimal meters otherwise; counts use truncated compact K/M suffixes. Zero action
time is blank and a positive percentage below or equal to 0.1 percent is shown as <0.1,
matching Orca. Tool changes show count without distance; categories for which Orca does
not provide these statistics retain blank columns. Slice Info feature and action labels
use the same 10px text as the numeric statistics columns, with compact 16px rows. The
statistics footer matches this typography and muted color, using 12px icons, a 16px
minimum row height, and compact divider spacing. The legend header uses muted 10px text
in normal case and a bottom divider, retaining its original alignment: Type at the left
edge and numeric column headings right-aligned. The Slice Info color-scheme row includes
a G-code text icon toggle on its left, using the same compact rounded gray
settings-button surface as the printer settings button. It shares visibility state with
the C shortcut and the text window close button, retaining that state across workspace
tab changes and new slice results. The G-code text window requires the workspace overlay
host and renders above the viewport and both sidebars; there is no inline viewport
fallback. Its drag and resize bounds cover the entire area between the title bar and
status bar; saved geometry uses this workspace coordinate space.
### Sidebar collapse and resizing

Title-bar sidebar toggles sit between Redo and Home on the left and before the window
controls on the right. Expanded sidebars use a teal pressed state. The left toggle is
available in Prepare and Preview; the right toggle is available in Preview. Collapsing
hides both the sidebar and its resizer without unmounting content or changing its saved
width. The viewport fills the released space; toggle state is saved independently as
`ui.leftSidebarCollapsed` and `ui.rightSidebarCollapsed` and restored at startup
(missing values default to expanded). Toggle writes are serialized to preserve rapid
changes to both sides.
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

### Material and option controls

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
Number-stepper styling uses two dark 18px buttons separated by
a 1px gap, with square inner corners and 2px outer corners. Gray plus/minus
icons use heavier strokes with flat ends, matching the supplied reference.
Numeric option steppers disable the decrease button at or below the native
minimum and the increase button at or above the native maximum. Their state
tracks the displayed draft and native effective-value updates; mixed values
and pending commits continue to disable both buttons.
Option-label and input tooltips include Orca's `parameter name`, with indexed
elements displayed as `key[index]`. `Default` uses serialized native parent
Process preset values supplied by each profile snapshot, independent of local
overrides and static option-definition defaults. Numeric defaults use the same
number and unit formatting as ranges; booleans use `true`/`false`, strings
preserve their text, and empty strings display `Empty string`. Enums and other
specialized types only show the parameter name and help, as in Orca.
Tooltips append Orca's `Range: [min, max]` for scalar and vector
numeric types only when both bounds are strictly inside the native `FLT_MAX`
sentinels. Endpoints use up to four decimal places without trailing zeros and
the native unit suffix, including Orca's space before `layers` and the
parent value's unit choice for float-or-percent options. Single-sided ranges
are omitted. Without a native parent value, both Default and Range are omitted.
Input tooltips also retain their effective-value-source message.
Configuration tooltips do not intercept pointer input over nearby controls.
Input-associated buttons share the same dark background and gray foreground
tokens, including Select/Combobox arrows and inline Combobox clear buttons.
Checkboxes use a borderless dark rounded outer square in both states. The
checked indicator occupies 70% of that square, with a teal fill, a fixed 2px
corner radius, and a white checkmark. Focus and disabled behavior are retained.
For printers whose effective nozzle diameter vector contains multiple extruders, the
Nozzle row uses a 52px-tall Sync button and a shared dark rounded container. Its left
variant selector places the Nozzle label above the current variant; the right side shows
equal-width navigation cards with each extruder number, actual diameter, and nozzle flow
abbreviation (SF/HF/XHF and the other native flow variants). Values come from the
effective native nozzle_diameter and nozzle_volume_type vectors; flow types beyond the
serialized vector length repeat its first entry, matching native
ConfigOptionVector::get_at semantics, retaining the canonical preset transition and
existing Sync placeholder. Single-extruder rows retain their compact layout. The Printer
preset editor opens from a 24px square settings button to the left
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
maximum, subject to the configuration panel's minimum size. Content growth from printer
transitions follows the same rule: the last measured content and viewport heights
determine whether the combined panel fitted before the change, so taller multi-extruder
rows or material lists expand it without testing the already-grown DOM for overflow. A
previously
scrolling panel keeps its user-selected split when content expands.

### Configuration scopes

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

### Selection and reset

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

### Overflowing tab bars

Horizontal tab bars respond to mouse-wheel input whenever their list or shared
Tabs root overflows horizontally, including title-bar pages, configuration
categories, and preset-editor pages. Vertical wheel movement scrolls the tab
bar horizontally; trackpad horizontal movement is retained. Non-overflowing
and vertical tab bars leave native scrolling unchanged, and Ctrl-wheel remains
available for zoom. The shared listener covers portal dialogs and is removed
when the app shell unmounts.

### Native toolhead selection and editing

- Single-nozzle printers show a read-only flow Select to the right of the
  Nozzle variant selector, using the same sidebar control presentation and
  the effective first `nozzle_volume_type` value. Flow editing remains deferred.
  The single-nozzle row uses one continuous dark surface with a 3:2 split
  between diameter and flow and a muted bold Nozzle label. Read-only flow
  controls retain the existing shared disabled styling.
  When the bed selector is present, the diameter control's right edge aligns
  with the Printer selector above, accounting for the Sync button and row gaps.
  Flow text aligns with the bed-type text above through the matching left inset.

- The unified Device Nozzle selector retains the effective profile variant
  after individual toolhead edits, matching Orca's `Sidebar::update_presets`.
  Physical diameter combinations do not add synthetic disabled variant entries;
  the nozzle cards and Multi. controls display each effective diameter.
  Every variant choice requires a canonical profile target across the native
  bridge, typed client, and UI. Nullable targets and their disabled-item branch
  are removed; variant-less display text does not manufacture a choice.

- Multi-nozzle printers expose Device and Multi. header tabs; single-nozzle
  printers keep their existing Printer section. Both tab contents stay mounted.
  Multi. presents selectable numbered toolhead cards with effective diameter
  and native flow type, followed by the selected head's diameter selector.
  Clicking a Device nozzle card opens Multi. and selects that same toolhead.
  Both views use the same tooltip with the extruder number, diameter, and
  native flow type.
  Multi. toolhead cards share Device nozzle cards' 44px height and 14px line
  height, with a 44px default width; selection styling does not increase
  their height.
  Flow type is displayed in a disabled selector; flow editing is deferred.

- Diameter choices are numeric physical values projected by the bridge from
  installed visible profiles of the current vendor/model and the effective
  current vector. Named/mixed printer variants are not parsed as diameters.
- One native command replaces only the requested index in the effective
  ordered nozzle vector, then searches same-vendor/model profiles for an exact
  vector match, including mixed-nozzle profiles such as U1's
  `[0.4, 0.4, 0.6, 0.6]`. Nozzle count and order must match. Candidate drafts
  participate in matching; duplicate exact matches use a stable canonical
  name, preferring the current profile when possible.
- A different matching profile uses the existing atomic Printer transition,
  compatibility refresh, and current-rack preservation. Otherwise the command
  edits only the selected nozzle's Printer draft through the native indexed
  editor. Other nozzle entries and flow values remain unchanged in this path.
- Both paths commit one undoable history entry and publish the complete
  profile, filament, plate, and scoped-configuration receipt, invalidating
  retained slice results. Stale revisions reject before mutation. The selected
  toolhead, Multi. tab, and lower configuration mode survive the update.

## File Manager

Help → File Manager opens or raises one non-modal floating window for the
current Emscripten filesystem. It is available during startup and after failure;
the mandatory first-use Setup Wizard blocks it while owning the workspace.
Startup completion preserves the open window and directory.

The draggable/resizable window shows the absolute Emscripten path and Name/Size
columns. Its first row is `../` (disabled at `/`), directories end in `/`, file
sizes are bytes, and directory sizes are blank. Double-click or keyboard
activation navigates directories or downloads exact file bytes/name through
the host. Refresh rereads the directory; errors preserve the path. Reopening
after close starts at `/`. Filesystem modification is outside this feature.
Keep the window topmost within the application and contained within the viewport,
with title-bar dragging and a visible resize handle, without blocking the
application behind it. Open menubar popovers remain interactive above it.
Web makes no operating-system topmost-window guarantee. Disabled rows show
neither hover styling nor a pointer cursor. Use the shared shadcn `Table`
primitives with the existing scroll viewport, sticky header, row navigation,
and keyboard activation; import `cn()` from the standalone `cn` package.
All reads use the typed Worker client; only an explicit download transfers
file bytes. Electron Help → Show Configuration Folder is a separate fixed
host command that opens Electron's `userData` directory and is available before
slicer initialization. Web omits it; the shared UI receives no OS path. The modal
Setup Wizard's command block applies while it owns the workspace.

## Memory display

The status-bar Memory popup distinguishes additive platform entries from
shared runtime diagnostics. Electron totals associated process working sets
and groups them by process type. Renderer/Worker JavaScript heaps and WASM
linear-memory capacity are labeled as already included, never added twice.
Web labels the available heap-plus-WASM sum as **Total memory estimate** and
does not invent OS process entries. Unavailable samples display that state.

Sampling starts when the popup opens and otherwise runs every five seconds,
with one nonoverlapping request and only the latest result retained. Browser
background throttling remains host-controlled. These diagnostics do not imply
exclusive process-memory accounting or introduce an eviction policy.

## Verification

Follow [testing guidelines](../doc/testing_guidelines.md). Shared component and
menu tests cover projection, dismissal, keyboard/resize behavior, File Manager
viewport containment, sticky-header/scroll ownership, and guards;
host tests cover native menu validation, OS dialogs, window lifetime and
browser downloads. Native macOS behavior requires macOS verification.
