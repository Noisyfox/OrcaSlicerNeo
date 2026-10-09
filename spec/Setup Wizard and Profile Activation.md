# Setup Wizard and Profile Activation

**Date:** 2026-10-09

**Status:** Major specification; direction and resource policy accepted.
Product and session policies remain under interactive clarification.
Implementation has not started.

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
needed by the activation settings and their dependencies.

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
- Other vendors are extracted into `/profiles`. Only vendors required by
  enabled configuration and their dependencies are linked into `/system`.
- Link each vendor's root JSON and its complete resource directory. Do not
  copy or individually link each preset file.
- A filament's display manufacturer (`filament_vendor`) is not its resource
  vendor identity. Activation must resolve the owning package correctly,
  including vendors needed solely for enabled filament profiles.
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
The catalogue lifetime and execution mechanism remain undecided.

## 3. Disable native vendor file caches in Neo WASM

Disable `.opc` vendor-cache reads, generation, and cache-only vendor discovery
through a Neo WASM compile-time macro in both serial and threaded builds.
The macro name and exact implementation are not yet fixed. Native desktop
Orca behaviour remains unaffected when the macro is absent.

Ship complete source JSON profile resources; this policy does not support
cache-only vendor packages. Normal profile loading and wizard catalogue
loading both use the JSON path. Runtime catalogue reuse is a separate decision
and is not forbidden by disabling vendor file caches.

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
fallback policy. The following selection policies are accepted; outstanding
choices in Section 5 must still be resolved before implementation.

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

## 5. Decisions still required

Clarify the following related groups interactively. These are questions, not
accepted requirements or a fixed implementation sequence.

| Group | Outstanding decisions |
| --- | --- |
| Applying to an existing project | Removing the active Printer or a material used by a slot; preserving preset drafts and temporary overrides; confirmation and fallback policy; project dirty state, slice invalidation, and Undo/Redo semantics. |
| Persistence and recovery | Activation schema and repository; existing installations without activation records; renamed or missing profiles; missing vendor packages; apply/save failure ordering and rollback. |
| Catalogue and runtime lifecycle | Separate native bundle versus isolated catalogue runtime; reuse while open or between openings; cancellation and loading feedback; interaction with New Project/runtime replacement and project-required vendors. |
| UI and acceptance | Visual parity scope; partially enabled material-group display; search and select-all semantics; keyboard/accessibility behaviour; desktop sizing and deferred mobile support; measured startup, repeated-wizard and memory acceptance criteria. |

For every clarification question, explain the current Orca behaviour and the
relevant Neo choices together. Resolve one question at a time. Update this
living specification after a related group is settled, rather than after each
individual answer. Preserve one authoritative record; do not create parallel
phase notes.

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
core/library inclusion, dependency-only vendors, JSON-only loading, reopening
and cancelling the wizard, activation persistence, application failures, and
the agreed existing-project policies. Follow the repository
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
  [Undo and Redo](Undo%20and%20Redo.md): constrain the unresolved live-session
  application policies.

No implementation milestone is marked delivered by this design record.
