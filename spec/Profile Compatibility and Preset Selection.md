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
- The native snapshot includes bed-type capabilities from the selected
  Printer's effective draft. Bambu vendors and printers with
  `support_multi_bed_types` enable selection. Choices preserve native enum
  order and serialized values, with model `not_support_bed_types` exclusions
  matched against native display labels, including the system-parent fallback.
  The default is resolved by native `Preset::get_default_bed_type`, including
  string/numeric profile defaults and Orca's fallback. Shared code consumes
  this projection without a printer-name table or a second filtering rule.

### Changing a profile

Selecting a Printer updates the Process candidates and revalidates the
multi-filament rack together with the selected Process. Selecting a Process
updates its compatible candidates and revalidates the rack. If a slot is no
longer compatible, OrcaSlicer's native fallback is applied by the Worker and
the complete rack snapshot is returned atomically.
Printer changes initialize the project bed type from a supported remembered
choice when supplied, otherwise from the new printer's native default, and
remove local bed-type overrides that it cannot support.
Editing the selected printer's bed capabilities performs the same corrections
inside that draft edit's history transaction. Both mutation and history
restore receipts carry the effective native capability projection.
If a selectable printer excludes its configured default, normalization uses
the first supported native choice. A printer without selection uses its
native default and clears local bed overrides.

While a Printer, Process, or global bed selection is in progress, the Printer,
Process, and global bed selectors and rack
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

`UserPreferences.rememberedBedTypes` stores one native serialized global bed
choice per canonical Printer name. Successful global bed edits and Printer
transitions persist their final native value through the existing serialized
preference repository; local plate overrides and history navigation never
write this memory. Preference IO failures preserve the native committed state
and all unrelated preferences.

Explicit Printer transitions accept an optional remembered bed value in the
same native transaction as Printer/rack compatibility, normalization, history,
and invalidation. The final effective Printer's native model-filtered choices
validate that seed. Missing, obsolete, excluded, or disabled-selection memory
uses the supported native default. Startup and New Project seed memory before
resetting the clean history baseline; boot then publishes the final native
scoped snapshot. Opened projects and Undo/Redo own their stored bed roots and
never replay preference memory. Malformed preference entries are discarded by
the shared host preference normalizer.

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


The compact global bed selector sits immediately to the right of the Printer
picker, using the shared dark sidebar dropdown, rounded trigger and separate
arrow surface. It displays the global native project value regardless of the
active plate's local override. Native capability choices supply both global
and plate-editor labels/order; unavailable or single-bed capabilities hide the
selectors. Narrow triggers truncate labels and preserve the complete global
label and inheritance explanation in their title.

Selection admission uses a synchronous pending guard, with all three pickers
disabled during selection, history publication, project replacement and serial
slicing. Threaded bed edits remain available: the native affected plate scope
owns result invalidation and cancellation. Global edits use the existing
configuration FIFO, so an immediately requested Slice waits for the committed
bed value. Rejections release pending controls and use the existing error
surface. The existing plate override highlight/Reset and value-source tooltip
remain the only local/inherited indicators; no inline source badges are added.

Project import preserves every supported global/local bed value from the archive.
After the effective imported Printer draft and plate metadata are installed,
unsupported global beds use the native default and unsupported local overrides
return to inheritance. The native load receipt reports these corrections and the
shared project notice displays them. Neo establishes the normalized replacement
as its clean history baseline; unlike Orca's post-baseline normalization, these
import corrections do not mark the newly opened project dirty. User preferences
never seed an opened project.
