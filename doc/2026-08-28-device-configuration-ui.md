# Device printer configuration UI

**Date:** 2026-08-28

**Status:** Implemented

**Scope:** Shared Device tab for managing saved Moonraker printer-console
configurations and mounting the injected platform WebView panel.

## Behaviour

The Device tab owns a local `selectedPrinterId` only. It loads the complete
version-1 printer document through `PlatformCapabilities.printers.configuration`
and never writes the current selection to that document or ordinary user
preferences. A newly added printer is left unselected; selecting a row is an
explicit user action. If the selected record disappears, the selection is
cleared and the mounted panel is disposed.

Add and edit use one configuration dialog with separate console and API base
URL fields, a closed Moonraker adapter choice, and a password-masked API-key
field. The existing printer configuration normalizer performs validation and
URL canonicalization before saving. API keys remain complete in the persisted
configuration document as required by the approved design, but are not
rendered as visible text, included in status/error copy, or passed to logging.

## WebView lifecycle

When a record is selected, Device mounts a WebView with no URL, requests the
fixed `moonraker-fetch-v1` built-in script only when the record has a non-empty
API key, then loads the record's console URL. The host therefore controls
document-start injection (Electron) while Web safely ignores the request in
its iframe adapter. Selection changes, console URL/API-key edits, deletion,
and unmount dispose the previous panel. Empty selection and invalid/missing
console URLs render an explicit empty state.

## Verification

Focused helper and jsdom component tests cover repository load/save and
normalization, rendered add/edit/delete confirmation, non-persisted selection,
masked-key visibility, injection/load ordering, and panel disposal when
selection is removed. No LAN or internet fixture is required.
