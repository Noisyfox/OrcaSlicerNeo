# Setup Wizard and Profile Activation

**Date:** 2026-10-09

**Status:** Major specification; resource, product, session, and UI policies
accepted through interactive clarification. Implementation has not started.

**Scope:** Orca-style Printer and Filament setup and management in the shared
Electron and Web application, system-profile activation, and native vendor
cache policy. This is a peer architecture specification to
[Grand Plan](Grand%20Plan.md), not an implementation task log.

## 1. Accepted direction

Use a shared React Setup Wizard backed by the native Orca profile engine.
Completing the wizard applies the accepted activation settings immediately;
it does not require restarting the application. The same feature must work
through the existing shared runtime and typed client in both hosts.

Activation controls the profiles available to the application. It is distinct
from the current Printer/Process selection and from the ordered material slots
of an open project. Selecting multiple materials in setup does not mean adding
that many material slots to the project.

The user has selected vendor-package loading granularity. A needed vendor is
parsed as a whole; native visibility and compatibility determine the admitted
workspace candidates. This feature does not introduce per-profile JSON pruning.

On-demand vendor download is outside the current scope. Every startup downloads
and extracts all supplied vendor packages. Full native catalogue construction
is deferred until the wizard is opened; normal startup parses only the vendors
identified by enabled printers, plus the always-enabled filament library.

## 2. Resource layout and startup

Use two MEMFS views of the same resources:

```text
/profiles/                         Complete extracted vendor resources
  OrcaFilamentLibrary.json
  OrcaFilamentLibrary/
  <Vendor>.json
  <Vendor>/

/system/                           Native startup load set
  <core package contents>          Extracted here directly
  OrcaFilamentLibrary.json         -> /profiles/OrcaFilamentLibrary.json
  OrcaFilamentLibrary/             -> /profiles/OrcaFilamentLibrary/
  <EnabledVendor>.json            -> /profiles/<EnabledVendor>.json
  <EnabledVendor>/                -> /profiles/<EnabledVendor>/
```

- Core resources are always present and extracted directly into `/system`.
- `OrcaFilamentLibrary` is always present, linked into `/system`, and loaded.
  It cannot be deselected by the wizard.
- Other vendors are extracted into `/profiles`. Only vendors explicitly named
  by enabled printer-model records are linked into `/system`.
- Link each vendor's root JSON and its complete resource directory. Do not
  copy or individually link each preset file.
- The optional vendor load set comes exclusively from `models[].vendor`.
  Filament names and display manufacturers (`filament_vendor`) never select
  additional vendor packages. `OrcaFilamentLibrary` is the permanent exception
  to printer-derived vendor inclusion; core is always extracted directly.
- MEMFS belongs to the current runtime and is reset when that runtime is
  recreated. Previous application runs do not leave extracted MEMFS files.

Normal startup reads the persisted activation settings before profile
initialization, establishes the `/system` view, and initializes native presets
with those settings. The existing unconditional all-installed bootstrap must
be replaced. Native compatibility remains authoritative; TypeScript does not
compose or flatten slicer configurations.

Opening the wizard uses the complete `/profiles` resource set to construct a
catalogue independent of the current project's live `PresetBundle`. Opening
or browsing the wizard must not enable all vendors in the working session.
Construct the temporary catalogue bundle on the existing WASM Worker;
its lifetime and interaction rules are defined below.

## 3. Disable native vendor file caches in Neo WASM

Disable `.opc` vendor-cache reads, generation, and cache-only vendor discovery
through a Neo WASM compile-time macro in both serial and threaded builds.
The macro name and exact implementation are not yet fixed. Native desktop
Orca behaviour remains unaffected when the macro is absent.

Ship complete source JSON profile resources; this policy does not support
cache-only vendor packages. Normal profile loading and wizard catalogue
loading both use the JSON path. The wizard also retains no parsed catalogue
or lightweight catalogue cache between openings; each opening regenerates it
from source resources.

MEMFS is recreated at startup, so newly generated vendor caches cannot speed
up the next startup. Disabling generation removes its serialization and
in-memory file storage cost. The size of the startup improvement is unmeasured;
repeated native loads within one runtime also lose file-cache acceleration.

Implement upstream-core changes as deliberate commits on a dedicated submodule
development branch, not as patches. Record the resulting commit and explicitly
update the superproject's submodule pin when implementation is authorized.
This specification does not itself change the submodule or its pointer.

## 4. Orca reference behaviour

The investigated desktop Orca Setup Wizard is `GuideFrame` in
`WebGuideDialog.cpp`, reached by `GUI_App::ShowUserGuide()`. The older
wxWidgets `ConfigWizard` is not the current Setup Wizard menu entry.

The current web wizard selects complete printer models and enables all listed
nozzle variants of a selected model. It supports manufacturer grouping,
search, and manufacturer-wide selection. Its Filament page filters by selected
models, material type, manufacturer, and text. Display rows group material
profiles by manufacturer, type, and the name before `@`; one selected row can
expand to multiple concrete preset names. Printer selection also selects the
model's declared default materials.

The current web wizard's material-to-machine projection uses explicit
`compatible_printers` mappings. This must not be conflated with the complete
native workspace compatibility rules, which also support conditions. Neo's
wizard follows the current Orca web-wizard projection; the workspace continues
to use the full native compatibility rules.

Desktop startup loads the vendor packages installed in its user `system`
directory, then applies AppConfig visibility, selection, and compatibility.
It does not skip individual disabled profiles within a vendor. Opening its
wizard can enumerate additional vendors from shipped resource profiles.
Neo preserves this separation using MEMFS links rather than copying installed
vendor resources to a persistent user directory.

The reference is evidence for clarification, not approval of every Orca UI or
fallback policy. The following policies are accepted. Section 5 distinguishes
remaining implementation design from product decisions.

### Accepted Printer and Filament selection policies

- Select a complete printer model, enabling every nozzle variant listed for
  that model. Do not add per-nozzle activation controls.
- Group filament rows by resolved `filament_vendor[0]`, resolved
  `filament_type[0]`, and the concrete preset name trimmed at the first `@`.
  These values come from parsed configuration, including inherited values;
  they are not filenames or resource-package vendor identities. Selecting a
  row enables its associated concrete preset names admitted by the wizard's
  catalogue projection, rather than creating a new material profile.
- Generate wizard filament candidates using Orca's explicit
  `compatible_printers` model/nozzle mapping. Do not substitute the broader
  workspace condition-expression evaluation in this UI.
- On submitting the selected printer models, automatically check their
  declared `default_materials`. Users may subsequently uncheck them on the
  Filament page. Returning to and resubmitting Printer selection can check
  the defaults again; do not add a special policy remembering their previous
  deselection.
- Before completing the full wizard, require at least one selected printer
  model and one selected filament row. Do not add a page-level check requiring
  compatible-material coverage for every model. Preserve the native default
  material supplementation during profile loading and return the effective
  native result; the initial UI selection is not necessarily the final
  supplemented activation set.

These rules apply to the full Printer/Filament setup flow. There are no
dedicated single-page entry points in this release.

### Accepted first-use and entry policies

- Automatically open setup when there is no activation record, or when no
  usable enabled printer remains. Existing-installation migration and invalid
  record recovery details remain in the persistence/recovery group.
- First-use setup cannot be cancelled or skipped. Users must complete valid
  Printer/Filament selection before entering the workspace. Do not silently
  install a default printer as a shortcut around this requirement.
- Provide one menu entry, Setup Wizard, for later management of both Printer
  and Filament activation. Do not add separate Printer-only or Filament-only
  entries, or management buttons beside workspace selectors.
- A later wizard opened from the menu can be cancelled. Cancellation discards
  its activation draft and leaves the current configuration unchanged.
- Show first-use setup before opening files. While first-use setup is pending,
  silently discard file-open requests, including startup requests. Do not queue
  them, show a notice, or automatically retry them after setup. Introduce no
  special pending-file handling for this flow; users can open files normally
  after completing setup.

For reference, Orca automatically invokes setup when its configuration is
absent or only built-in default printers remain, supports additional
single-page entry points, and loads startup files before scheduling its wizard
check. Neo adopts the automatic-setup principle but uses the simpler entry and
first-use file policies above.

### Accepted existing-project application policies

- When setup adds a printer model, use Orca's native preferred-printer rules
  to activate a newly added model/variant, even if the previous Printer remains
  enabled. Do not add a keep-current-Printer policy for this flow.
- If the active Printer is disabled, automatically select a remaining enabled
  Printer through native selection rules. Do not add a replacement-Printer
  selection dialog.
- Reuse Neo's existing runtime-draft and Printer-transition mechanisms. Do not
  add Orca's save/transfer-edits dialog, or transfer the old Printer's edits
  onto the new source. Existing source drafts remain available in the current
  session; the target source reactivates its own draft when one exists.
- If a rack source becomes unavailable because setup disables it, automatically
  replace the affected slot's source with a native-compatible material. Retain
  the slot rather than deleting it, and do not add a replacement-material
  picker. The displaced source draft remains dormant for the current session.
  An actual Printer transition still follows Neo's existing remembered-rack
  restoration and compatibility-normalization rules.
- Replacement sources initialize actual slot colours from the newly effective
  preset/draft default, following Neo's existing source-selection rules. Slots
  whose sources are unchanged retain their colours. Do not add wizard-specific
  colour restoration; colours change together with their source replacements.
- Global activation preferences do not participate in project Undo/Redo.
  After activation is saved and successfully applied, clear the project
  Undo/Redo history and establish the resulting project state as the new
  history baseline, even when only the candidate set changed. A failed
  application does not clear history. Do not retain disabled source presets
  solely to restore pre-application history, and do not add complete source
  preset data to history snapshots for this feature.
- A change to the effective Printer, material, or slicing configuration marks
  the project dirty, invalidates the previous slice, clears stale preview, and
  disables G-code export until re-slicing. If activation changes leave the
  current project configuration unchanged, retain its dirty state and slice
  result without introducing a new modification.

These policies reuse Neo's project-draft and colour contracts, with explicit
history clearing after successful setup application. They do not reproduce
desktop Orca's preset-file editing and configuration-reload implementation.

### Accepted persistence and recovery policies

- Extend the existing shared UserPreferences repository with a dedicated
  activation record. Reuse the Electron/Web persistence adapters; do not add
  an independent activation file or restore the retired whole-AppConfig API.
- Follow Orca's `models` and `filaments` JSON shapes inside that record:

  ```json
  {
    "models": [
      {
        "vendor": "BBL",
        "model": "Bambu Lab X1 Carbon",
        "nozzle_diameter": ["0.4", "0.6"]
      }
    ],
    "filaments": ["Generic PLA @BBL X1C"]
  }
  ```

  This illustrates the record payload, not the entire UserPreferences schema.
  The enclosing field name and schema versioning are implementation details.
  Every model explicitly stores its resource vendor before native profile
  loading. Never infer vendor identity by looking up a printer preset name.
  Filaments store concrete preset names only and do not carry resource-vendor
  selection metadata.
- Existing Neo installations without this record enter mandatory first-use
  setup. Do not infer an activation set from old selected-profile preferences
  or remembered material racks.
- Retain stale activation records rather than deleting them automatically.
  Use Orca's native historical preset-name resolution, including
  `renamed_from`, where applicable. Unmatched model/variant records do not
  enable a printer; unresolved filament records remain recorded while native
  default supplementation and compatible fallback resolve the live session.
  Do not invent a printer-model identifier migration from preset rename data.
  If no usable enabled printer remains, automatically open setup.
- Preserve the existing package-error policy: log and skip a failed vendor
  download/extraction; a core-package failure terminates startup. Do not delete
  activation records for temporarily unavailable vendors or add a special
  partial-startup recovery flow. The normal no-usable-Printer rule still applies.
- Persist the accepted activation settings before applying them to the running
  session. If persistence fails, do not apply; keep the wizard open, show the
  error, and allow retry.
- If persistence succeeds but native application fails, retain the newly saved
  activation settings, show the error, and allow retrying application. Do not
  implement cross-storage/runtime rollback. A subsequent startup reads the
  newly saved settings. Success must not be reported for a failed application.
- Treat an activation record that is malformed or has an unsupported format
  version as absent, using the existing preference normalization mechanism.
  Enter mandatory setup without adding backup recovery or a dedicated repair
  dialog. Preserve other preference fields that can still be read normally.

The pre-save validation/normalization and native apply operations must respect
this save-before-apply ordering. Exact transport and supplemental-material
publication details remain part of implementation design.

### Accepted catalogue and runtime lifecycle policies

- Build the complete wizard catalogue in a temporary, independent native
  `PresetBundle` on the existing WASM Worker. Do not introduce a second Worker
  or WASM module, and do not populate the live project's bundle with every
  vendor merely to display the wizard.
- Generate the catalogue from scratch on every opening. Retain the temporary
  bundle and projected catalogue only while the wizard is open; release them
  on close. Keep the extracted source resources in `/profiles`, without a
  full or lightweight parsed-catalogue cache between openings.
- Show a loading state while generating the catalogue and disable selection,
  navigation, completion, and cancellation until generation finishes. Do not
  implement cancellation of an in-progress native catalogue load. Once loaded,
  a menu-opened wizard may be cancelled; mandatory first-use setup may not.
- Make the wizard modal and block workspace operations while it is open.
  Disable its menu entry during slicing, project loading/saving, and other
  conflicting project operations. Disable cancellation during application.
- Allow 3MF project-embedded configurations independently of global activation.
  Opening a project does not change saved `models` or `filaments`, and does not
  link an otherwise disabled vendor just because the file references it.
- New Project does not trigger another setup flow or an extra package download.
  If the runtime is recreated, initialize it from the saved activation settings
  and rebuild the printer-derived vendor links. Show mandatory setup only when
  the activation record is absent or no usable enabled Printer remains.

For reference, Orca uses a temporary native bundle when the installed bundle
cannot supply a complete wizard catalogue, and also has a persisted wizard
catalogue cache. Neo uses the temporary-bundle approach but regenerates on each
opening. Orca's New Project resets project state and can reload presets without
replacing global activation settings. Neo retains that separation.

### Accepted UI and performance policies

- Preserve Orca's two-page information and operation structure, using Neo's
  existing fonts, colours, controls, and modal styling rather than requiring
  pixel-identical reproduction. The Printer page groups model cards by vendor
  with images, names, and nozzle information. The Filament page provides model,
  material-type, manufacturer, and text filters with grouped material rows.
- Match Orca's two-state material-group selection. If any concrete member of a
  group is enabled, initially show the row checked. Submitting a checked row
  enables all of its members admitted by the current wizard projection; do not
  introduce a partially checked material-row state.
- Search and filters change display only, preserving hidden selections.
  Printer vendor-wide selection affects the currently displayed models of that
  vendor. Filament Select All and Deselect All affect currently displayed rows.
  Hidden selections retain their state, matching Orca's filtered bulk actions.
- Use standard keyboard-accessible controls: Tab moves focus, Space toggles a
  focused checkbox, and Enter activates a focused button. Escape cancels a
  menu-opened wizard when cancellation is available; mandatory first-use,
  catalogue loading, and application do not allow cancellation. Do not add
  Orca's automatic search focus on ordinary character input or other custom
  shortcuts in the first release.
- Do not set an arbitrary hard timing or memory threshold before measurement.
  Report normal startup, first wizard opening, repeated wizard opening, and
  WASM memory before catalogue construction, after construction, and after
  closing. Verify that startup parses only enabled vendor packages plus the
  permanent library, and that closing releases the temporary catalogue data.
  Reassess optimization needs from measured results. Releasing allocations
  does not require the WASM heap's high-water capacity to shrink.

## 5. Remaining implementation design

The accepted product decisions above define the implementation scope. Native
application and pre-save validation/normalization still need a concrete design
that preserves save-before-apply ordering, existing source-draft behaviour,
native supplementation, and the new history-baseline rule. This specification
records no implementation as delivered.

For any further product clarification, explain current Orca behaviour and the
relevant Neo choices together, resolve one question at a time, and update this
specification after a related group is settled. Preserve one authoritative
record rather than parallel phase notes.

## 6. Boundaries and verification

Application code uses the shared runtime. New direct Emscripten/FS operations
are encapsulated by the typed client on the Worker side. No wxWidgets GUI is
ported. Catalogue enumeration and activation must not reset the live project
through `orc_init()`, which clears project-related runtime state and history.
The safe immediate-application mechanism is still to be designed.

Existing serial-WASM exploration established that root JSON and directory
symlinks permit native vendor loading, that unlinked resource vendors do not
appear in startup printer candidates, and that removing links retains source
files. It also demonstrated that generated `.opc` files can keep a vendor
loadable after its links are removed. The cache macro is accepted but has not
been implemented or built. This is bounded feasibility evidence, not feature
acceptance or cross-host/threaded verification.

Implementation verification must cover the startup vendor load set, permanent
core/library inclusion, printer-derived vendor inclusion, JSON-only loading,
reopening
and cancelling the wizard, activation persistence, application failures,
successful-application history clearing, project-embedded configurations, and
the agreed existing-project and filtered-selection policies. Follow the
repository
[testing guidelines](../doc/testing_guidelines.md) for unit/typecheck,
affected-host E2E, native quick-build/smoke, and handoff scope.

Both hosts retain the shared application's desktop input target. Mobile
support remains deferred. Performance reporting must distinguish all-package
download/extraction and raw resource memory from native parsing, inherited
configuration allocation, catalogue construction, and cache serialization.

## 7. Relationship to existing specifications

- [Web–Electron Shared Application Architecture](Web-Electron%20Shared%20Application%20Architecture.md):
  retains full package delivery and the shared Worker/client boundaries. Once
  implemented, this specification replaces its all-vendors-installed startup
  policy and extends activation persistence; it does not restore the retired
  whole-AppConfig public API.
- [Profile Compatibility and Preset Selection](Profile%20Compatibility%20and%20Preset%20Selection.md):
  continues to govern current Printer/Process selection and native-compatible
  workspace candidates.
- [Multi-Filament Support](Multi-Filament%20Support.md): continues to own the
  project's rack, colours, mappings, and remembered-rack semantics.
- [Preset Editor Dialog](Preset%20Editor%20Dialog.md),
  [3MF Project Persistence](3MF%20Project%20Persistence.md), and
  [Undo and Redo](Undo%20and%20Redo.md): constrain the accepted live-session
  application policies and their implementation.

No implementation milestone is marked delivered by this design record.
