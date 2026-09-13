# Profile Compatibility and Preset Selection

**Date:** 2026-09-09

**Status:** Approved; implemented as the Printer/Process boundary of the
multi-filament application.

**Scope:** System FDM Printer and Process selection in the shared Electron and
Web application. Filament material state is specified by
[`Multi-Filament Support.md`](Multi-Filament%20Support.md).

## User experience

The Printer and Process selectors represent one native-compatible
configuration. The application uses OrcaSlicer's compatibility outcome,
including inherited profiles, explicit compatibility lists, and compatibility
conditions. Profiles from another vendor remain available when OrcaSlicer
considers them compatible.

### Available profiles

- The Printer selector shows installed, visible FDM printers.
- The Process selector shows only installed, visible processes compatible with
  the selected Printer.
- Incompatible profiles are hidden. There is no option to reveal or select
  them in this release.
- Profiles keep OrcaSlicer's source order. The application does not sort them.
- The native profile snapshot also provides `filament_catalog`, an
  engine-filtered candidate catalogue consumed by the multi-filament rack.
  Catalogue entries do not carry a selected flag and are not a third selector.

### Changing a profile

Selecting a Printer updates the Process candidates and revalidates the
multi-filament rack together with the selected Process. Selecting a Process
updates its compatible candidates and revalidates the rack. If a slot is no
longer compatible, OrcaSlicer's native fallback is applied by the Worker and
the complete rack snapshot is returned atomically.

While the update is in progress, the Printer and Process selectors and rack
commands are temporarily disabled. A stale candidate or stale rack revision
cannot be selected.

Every successful profile change clears temporary setting overrides and makes
the existing slice result obsolete. The preview, layer controls, and G-code
export remain unavailable until the user slices again.

### Starting the application

The last selected Printer and Process are restored in that order. If one is
unavailable or incompatible, the native fallback is used. The resolved
Printer/Process names are saved so the next launch presents the configuration
actually in use.

For a new project, the selected Printer's remembered rack is then used as a
seed. An opened project owns its complete rack and always takes priority over
that remembered seed. There is no single selected-filament preference or
startup filament-selection call.

## Scope

Native `PresetBundle` compatibility remains the only compatibility authority.
React does not filter a second filament list, construct fallback presets, or
reproduce native matching rules. The only public profile-selection operation
is `selectProfile('printer' | 'print', name)`; the native
`orc_select_preset` endpoint accepts only `printer` and `print`.

No legacy single-filament selector, API, preference field, project tuple,
history state, sidecar member, selected wire flag, compatibility special case,
or migration code exists. This release has not shipped, so no compatibility
migration is required or permitted.
