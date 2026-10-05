# Reusable Color Picker

Date: 2026-10-05
Status: Approved design; implementation in progress
Scope: Shared desktop Electron and Web UI, reusable color editing and favorites

Internal callers and tests use the new component contract directly. No legacy
color-input event emulation, compatibility aliases, or internal API fallback
paths are retained. Missing optional fields in persisted user documents are
handled by configuration normalization, not an internal API compatibility layer.

## Component contract

The UI belongs to `packages/slicer-app/src/components/ui/`. A controlled
`ColorPicker` panel receives its value, change callback, palettes, favorites,
and favorite actions. `ColorPickerDialog` owns a draft and commits only on
Confirm. Cancel, Escape, and dismissal discard the color draft; explicit
favorite additions and removals remain saved. The reusable UI does not read
platform storage or call the slicer runtime. A Popover wrapper is deferred.

`enableAlpha` and `enableGradient` default to false. Values are discriminated
solid colors or fixed-direction, two-endpoint linear gradients. Opaque output
is `#RRGGBB`; alpha-enabled output is `#RRGGBBAA`. Alpha is the last byte,
internally 0–1 and displayed as 0–100%. Each gradient endpoint has independent
color and alpha. No gradient angles, extra stops, or business transparency
support is included.

RGB/HSL inputs, HEX, and the hue/lightness spectrum share mathematical color
conversion and positioning, with adjustable saturation. Achromatic and fully
transparent edits preserve useful hue/color information. Controls reuse NEO's
Base UI wrappers and semantic theme tokens. Preview and translucent swatches
use a checkerboard. The panel has a scrollable preset palette beside the
editor, with preview and favorites below. Preset palettes are replaceable
data; RAL colors from the reference are display approximations.

## Favorites and configuration

Favorites are global user preferences, independent of printers and projects.
The optional `colorPicker.favorites` field uses the existing version-1
preferences document and [shared host contract](../spec/Web-Electron%20Shared%20Application%20Architecture.md).
Electron saves `preferences.json` in its user-data directory; Web uses
`orca-slicer-neo:preferences`. Old documents start with no favorites.
Normalization filters malformed data, canonicalizes colors, and removes
duplicates. Opaque six/eight-digit equivalents are identical.

Explicit additions/removals save immediately. New favorites appear first.
There are at most 24 entries; a full collection requires removal rather than
silent eviction. Alpha-disabled instances hide translucent entries and
gradient-disabled instances hide gradient entries without deleting them.
Preference updates share repository-scoped serialization so unrelated UI,
rack, selection, arrangement, and favorite writes preserve one another.
Host persistence failures retain the established console/session fallback;
durability is conditional on successful storage.

## Business integration

Filament rack and preset-editor color controls use the shared dialog with
alpha and gradients disabled. Color drafts remain local until confirmation;
the existing runtime commands, disabled states, errors, and history ownership
remain authoritative. This work introduces no C++/WASM changes.

## Support and verification

Desktop Electron and desktop Chrome are supported. Pointer events permit
touch input but mobile product support remains deferred under the shared
architecture. Color operations are constant-time; palettes and favorites are
small data lists, without pixel searches, runtime work, or network services.

Verification follows [testing guidelines](testing_guidelines.md): color
conversion and normalization tests, real component interaction tests,
cross-writer preference regression tests, affected package suites/typechecks,
root suites/typechecks, focused Electron UI and disk-restart tests, and Web
storage/reload checks. Alpha/gradient behavior is verified at the reusable
component layer even though existing business entrances disable it.
