# Reusable Color Picker

Date: 2026-10-15
Status: Delivered
Scope: Shared desktop Electron and Web UI, reusable color editing and favorites

Internal callers and tests use the new component contract directly. No legacy
color-input event emulation, compatibility aliases, or internal API fallback
paths are retained. Missing optional fields in persisted user documents are
handled by configuration normalization, not an internal API compatibility layer.

## Component contract

The UI belongs to `packages/slicer-app/src/components/ui/`. A controlled
`ColorPicker` panel receives its value, change callback, palettes, favorites,
and favorite actions. `ColorPickerPopover` owns a draft and commits only on
Confirm. Cancel, Escape, and dismissal discard the color draft; explicit
favorite additions and removals remain saved. The reusable UI does not read
platform storage or call the slicer runtime. The nonmodal Popover is anchored
to the clicked color button, aligns to its start edge, and automatically shifts
or flips to remain inside the viewport. Outside clicks cancel the draft without
blocking the rest of the application. Nested preset-editor popovers preserve
their parent dialog when dismissed.
The visible title bar can be dragged with the primary pointer button. Pointer
capture keeps the gesture active outside the header; release, cancellation,
lost capture, and unmount end it. After dragging, the popup uses a viewport
position and stays within the viewport as its contents or the viewport resize.
Palette expansion preserves the chosen top-left position whenever it fits.
Position is local to this opening; reopening anchors to the color button again.
Right clicks inside the color popup do not open the enclosing filament card's
context menu. Native input editing menus retain their established behavior.

`enableAlpha` and `enableGradient` default to false. Values are discriminated
solid colors or fixed-direction linear gradients with 2 to 7 ordered colors.
The current gradient contract is `{ kind: 'linear-gradient', colors: string[] }`
through UI, preferences, typed client, mock runtime, and native bridge. The old
start/end object is rejected; existing favorites are not migrated. Opaque output
is `#RRGGBB`; alpha-enabled output is `#RRGGBBAA`. Alpha is the last byte,
internally 0–1 and displayed as 0–100%. Each gradient color has independent
color and alpha. Gradient stops are evenly spaced; angles and stop positions
are not editable. New gradients and added colors use Orca's 75-degree hue
shift and lightness contrast calculation, retaining the source alpha byte.

The layout and interactions follow [OrcaSlicer commit 26f5fd6](https://github.com/OrcaSlicer/OrcaSlicer/commit/26f5fd6251de6a7b4ae6280d550dae7045b0026a).
A collapsible palette sidebar places its selector below the independently
scrollable color list. Search swaps the selector for a name/HEX filter, with
an empty-result notice. Closing search clears it; Escape closes search before
it dismisses the color popup. The selected palette and sidebar visibility are
shared user preferences; unsupported palettes fall back to Basic for that caller.

A vertical saturation slider sits beside the hue/lightness spectrum. HEX,
optional opacity percentage, RGB and HSL inputs are visible together below it.
The Solid/Gradient switch uses the dark control background, neutral secondary
surface for the selected segment, and foreground/muted-foreground text roles.
It remembers each mode's last selection. A gradient
track selects the nearest fixed stop on click; keyboard-accessible stop tabs
select an individual color. Add inserts after the active stop and selects it;
Remove deletes the active stop, with a minimum of two and maximum of seven.
The gradient track, selected stop, and add/remove buttons are 20 CSS px high;
inactive stops are 10 CSS px squares. Stops stay centered while pressed, with
their first/last centers inset 10 px from the track ends. Buttons sit 10 px
away from the track, with a 6 px gap between them. The HSL and RGB columns
are 52 px wide with 5 px gutters, leaving the gradient track the reference
layout's share of the editor width.
The opacity slider occupies the gradient track row while the opacity input or
slider is in use. Focusing or clicking another control closes it.

RGB/HSL inputs, HEX, and the spectrum share mathematical conversion and
positioning. Achromatic and fully transparent edits preserve useful hue/color
information. Alpha remains byte-precise across color edits and stop switches;
a six-digit HEX edit preserves the current alpha. HEX typing does not rewrite
the text or caret until blur. Out-of-range numbers clamp to their bounds. Mouse wheel input steps numbers
by one and sliders by five. Invalid HEX and empty numeric
edits retain the last valid color, show feedback, and block confirmation and
favorite saving. A spectrum or palette selection replaces invalid editor text.

Original and current color previews sit to the left of the favorites grid.
Clicking Original restores the full opening selection, including gradient
order and alpha; clicking the current preview saves/promotes a favorite.
Favorites match Orca's 16 slots, displayed in two rows of eight. Checkerboards
appear under translucent colors. Controls reuse NEO's Base UI wrappers and
semantic theme tokens, including borderless fields and secondary actions.
The popup fits content width and available viewport height; the spectrum can
shrink while the palette list scrolls independently. Preset palettes are
replaceable data; the built-in gradients include all 2-to-7-color upstream
entries, and RAL colors are display approximations.

## Favorites and configuration

Favorites are global user preferences, independent of printers and projects.
The optional `colorPicker.favorites` field uses the existing version-1
preferences document and [shared host contract](Web-Electron%20Shared%20Application%20Architecture.md).
Electron saves `preferences.json` in its user-data directory; Web uses
`orca-slicer-neo:preferences`. Old documents start with no favorites.
Normalization filters malformed data, canonicalizes colors, and removes
duplicates. Opaque six/eight-digit equivalents are identical.

The optional `colorPicker.ui` stores `sidebarOpen` and `paletteId`; missing
state defaults to a collapsed Basic palette. Layout and favorite writes use
the same repository transaction queue and preserve each other.

Explicit additions/removals save immediately. New favorites appear first.
Adding an existing favorite moves it to the first position without duplicating
it, including when the collection is full. Favorite swatches expose a
red "Remove favorite" context-menu action instead of an overlay button, available
through right click or keyboard context-menu invocation. NEO tooltips show the
stored HEX value, or both endpoint HEX values for a gradient.
There are at most 16 entries. Saving a new color at capacity drops the oldest
favorite; saving an existing color moves it to first without duplication.
Alpha-disabled instances display stored translucent favorites and normalize
selected results to opaque. Gradient-disabled instances hide gradient entries
without deleting them.
Preference updates share repository-scoped serialization so unrelated UI,
rack, selection, arrangement, and favorite writes preserve one another.
Host persistence failures retain the established console/session fallback;
durability is conditional on successful storage.

## Business integration

Filament rack color controls enable alpha and gradients with 2 to 7 colors;
the preset editor remains solid-only with alpha disabled. Filament color
drafts remain local until confirmation, when one typed native command changes
the complete slot color tuple and records one history operation. Imported
gradients of up to seven colors open with their entire ordered sequence.
Partitions and longer gradients show a preservation notice and open from the
first color; Cancel and unchanged Confirm retain all original native metadata.
An explicit edit replaces it with the selected solid or gradient. Unchanged
canonical solids and gradients create no mutation. Alpha-only edits commit
once. Rack commands store opaque colors as `#RRGGBB` and translucent colors
as `#RRGGBBAA`; both formats are accepted by the typed client and bridge.
The first gradient color is the representative; all colors are serialized in
order into Orca's space-separated `filament_multi_colour` with type `0`.
Disabled states and errors remain controlled by the runtime.

Translucent filament swatches display the colour over the same checkerboard
used by the picker: fixed white and light-grey squares, independent of the
application theme. One shared swatch renderer serves the picker, rack, nozzle
mapping, object-list assignment cells and choices, Change Filament context
menus, painting-panel filament choices, device materials, and print-source
selection. Number and label contrast uses the representative colour composited
over the checkerboard average, including alpha.
Solid, gradient, and partitioned swatches preserve their native colour order;
any translucent colour enables the checkerboard underneath the full swatch.
Opaque swatches retain their existing appearance. This background affects UI
swatches only and does not change model rendering.

Prepare model and painted-facet materials use filament alpha. Following Orca's
render-colour adjustment, alpha below 0.1 displays as white at opacity 0.3 so
the model remains visible. Preview shells retain their independent opacity
0.15 overlay; toolpath colours remain RGB.

## Support and verification

Desktop Electron and desktop Chrome are supported. Pointer events permit
touch input but mobile product support remains deferred under the shared
architecture. Color operations are constant-time; palettes and favorites are
small data lists, without pixel searches, runtime work, or network services.

Verification follows [testing guidelines](../doc/testing_guidelines.md): color
conversion and normalization tests, real component interaction tests,
cross-writer preference regression tests, affected package suites/typechecks,
root suites/typechecks, focused Electron UI and disk-restart tests, and real
Web serial/threaded storage/reload checks. Alpha/gradient behavior is verified
at the reusable component layer; the filament rack also verifies all gradient
colors, cancellation, conversion of imported multi-colour metadata, and
representative-colour persistence through its business entrance. Rack tests
also cover imported alpha, unchanged confirmation and alpha-only edits. Native
WASM verification exercises seven-color gradient order, independent alpha, rollback, Undo/Redo,
and standard 3MF export/reopen preservation.

## Implementation entry points

`components/ui/color-picker.tsx` exports the controlled panel and
`components/ui/color-picker-popover.tsx` exports the draft popover. Both accept
`value`, optional capability flags, custom `palettes`, `favorites`, and
`onFavoriteAdd`/`onFavoriteRemove`. The panel publishes `onChange`; the popover
accepts `open`, `onOpenChange`, and `onConfirm`. Capability changes also apply
when confirming an already open popover.

`components/color/UserColorPickerPopover.tsx` binds the shared UI to
`lib/useColorFavorites.ts`. The latter uses the injected preferences repository.
All application preference writers use `updateUserPreferences` from
`@orca/platform-contract` to serialize read-modify-save transactions.

```tsx
<ColorPickerPopover
  value={{ kind: 'solid', color: '#33669980' }}
  enableAlpha
  open={open}
  onOpenChange={setOpen}
  trigger={<Button>Choose color</Button>}
  onConfirm={setColor}
/>
```
