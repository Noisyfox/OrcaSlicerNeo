# Profile Compatibility and Preset Selection

**Status:** Implemented
**Scope:** System FDM profile selection in the shared Electron and Web application.

## User experience

The Printer, Process, and Filament selectors always represent one compatible
configuration. The application uses the same compatibility outcome as
OrcaSlicer, including inherited profiles, explicit compatibility lists, and
compatibility conditions. Profiles from another vendor remain available when
OrcaSlicer considers them compatible.

### Available profiles

- The Printer selector shows installed, visible FDM printers.
- The Process selector shows only installed, visible processes compatible with
  the selected Printer.
- The Filament selector shows only installed, visible filaments compatible with
  both the selected Printer and Process.
- Incompatible profiles are hidden. There is no option to reveal or select
  them in this release.
- Profiles keep OrcaSlicer's source order. The application does not sort them.

### Changing a profile

Selecting a Printer updates the Process and Filament selections and their
lists together. Selecting a Process updates the Filament selection and list
together. If the previous choice is no longer compatible, the same fallback
that OrcaSlicer would choose is used.

While the update is in progress, all three selectors are temporarily disabled
without changing the sidebar layout. When it finishes, the selectors show only
the final, compatible choices; a stale list can never be selected.

Every successful profile change clears temporary setting overrides and makes
the existing slice result obsolete. The preview, layer controls, and G-code
export remain unavailable until the user slices again.

### Starting the application

The last selected Printer, Process, and Filament are restored in that order.
If one is unavailable or incompatible, OrcaSlicer's normal fallback is used.
The final choices are saved so the next launch presents the configuration that
is actually in use.

## Scope

This release supports installed system FDM profiles and one active Filament.
SLA profiles, custom/imported profile management, profile editing, temporary
compatibility-changing edits, and multi-material filament slots are outside
this feature's scope.
