# Setup Wizard and Profile Activation

**Date:** 2026-10-09

**Status:** Major specification; resource, product, session, and UI policies
accepted through interactive clarification. Step 1 contracts and persistence
are implemented. Steps 2–5 JSON-only vendor loading, activation-aware
startup, temporary full catalogue, and prepare/save/apply are implemented and
self-verified. Detailed project-transition acceptance in Step 6 and the UI
remain pending.

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
The policy macro is `NEO_DISABLE_VENDOR_CACHE`. Native desktop
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

## 5. Implementation sequence

Implement the following eight pieces in order, validating and committing each
complete, independently testable piece. Implementation status and verification
are recorded beneath the corresponding step. Keep this specification as the authoritative
feature record rather than introducing parallel phase documents.

Internal APIs change together across the native bridge, typed client, runtime,
and application callers. Do not add legacy adapters, protocol-version
negotiation, dual execution paths, or old-interface fallbacks. Persisted
preference validation remains subject to the accepted recovery policies;
it is distinct from internal API compatibility.

### Step 1 — Activation data and internal contracts

Extend `UserPreferences` with the activation record using the accepted
`models` and `filaments` payload. Every printer-model record explicitly carries
its resource vendor. Reuse the existing preference repository and host adapters.

Define typed operations for opening and closing the catalogue, validating and
preparing activation, and applying activation. Carry them through the existing
bridge/client/runtime boundary and Worker transport. Final operation names are
implementation details; application code must not access the module or FS.

**Validation:** preference round trips, missing/malformed activation handling,
preservation of other preference fields, and serialized preference updates
that do not overwrite concurrent changes. Typecheck affected contracts and
callers together.

### Step 1 implementation and verification — 2026-10-09

`UserPreferences.profileActivation` stores the accepted `models`/`filaments`
shape. Storage normalization clones valid records, retains stale source names,
and rejects the entire malformed record without removing other readable
preferences. Models must explicitly identify a resource vendor; vendor names
cannot contain path separators or control characters. There is no activation
schema version or migration layer. Empty selections remain structurally valid;
native usable-printer detection will decide whether setup is required.

The typed client defines `openSetupWizardCatalogue`,
`closeSetupWizardCatalogue`, `prepareProfileActivation`, and
`applyProfileActivation`. Existing generic Worker dispatch and runtime exports
carry the methods without another transport or adapter. The preparation result
contains the activation to persist; the application result publishes profile,
filament-session, and history snapshots plus configuration-change information.
Prepared state belongs to the current wizard, so apply takes no duplicated
selection payload or compatibility token. Native implementations are pending
Steps 4–6. Calling a missing export fails through the existing transport;
there are no production success stubs, feature negotiation, or old-API fallbacks.
All four operations are rejected before posting during serial slicing.

Self-verification:

- `pnpm --filter @orca/platform-contract test`: 39 tests passed.
- `pnpm --filter @orca/platform-contract typecheck` and
  `pnpm --filter @orca/platform-contract test:import-guard`: passed.
- `pnpm --filter @orca/slicer-wasm test`: 380 tests passed, including setup
  transport, missing-export rejection, and serial-slicing command gates.
- `pnpm --filter @orca/slicer-runtime test`: 42 tests passed.
- `pnpm --filter @orca/web exec vitest run src/browserAdapter.test.ts`:
  18 tests passed, including activation storage round trip.
- `pnpm --filter @orca/desktop exec vitest run src/renderer/src/platform/electronAdapter.test.ts`:
  30 tests passed, including activation round trip through the host repository.
- Typechecks for `@orca/slicer-wasm`, `@orca/slicer-runtime`, `@orca/slicer-app`,
  `@orca/web`, and `@orca/desktop`: passed.
- `git diff --check`: passed.

No C++ bridge, build scaffold, artifact, application caller, or UI changed in
this piece; native builds and host E2E are not run. Injected native responses in
Worker tests prove dispatch and error transport only, not catalogue or live
activation behaviour. Parent independent acceptance passed: the 39-test platform-contract suite,
27-test Worker suite, both adapter suites (18 Web and 30 Electron tests),
platform import guard, and platform-contract/client/runtime typechecks were
rerun successfully. Source review confirmed stale identities remain durable,
missing native exports reject, and setup commands are not posted during serial
slicing. Native behaviour remains pending later steps.

### Step 2 — Disable native vendor caches

On a dedicated submodule development branch, add the Neo WASM macro that
excludes `.opc` reads, generation, and cache-only vendor discovery. Enable it
for both serial and threaded WASM in the superproject build scaffold; leave
native desktop behaviour unchanged when the macro is absent.

Commit the deliberate upstream-core adaptation directly in the submodule,
then explicitly update and document the superproject's pinned commit. Do not
introduce a patch-based adaptation for this work.

**Validation:** source-JSON loading succeeds, loads generate no `.opc` files,
and an existing `.opc` cannot make an unlinked vendor loadable. Run the affected
native quick build and focused smoke; prove both variants before handoff.

### Step 2 implementation and verification — 2026-10-09

The intentional core adaptation is on submodule branch
`dev/setup-wizard-no-vendor-cache`, based on pinned commit
`9d3118b7a406a4e44d5344ae69c084f01d72e772`. Independently accepted submodule
commit: `b5dd4979cfce248e88a547c3dcddb6eb6e3132cc`; the superproject explicitly
pins this adaptation.

`NEO_DISABLE_VENDOR_CACHE=1` is applied by the WASM CMake scaffold to
`PresetBundle.cpp`, `PresetCacheFormat.cpp`, and `utils.cpp` in both variants.
Source-scoped definitions keep the policy within the discovery/loading/IO
translation units without rebuilding unrelated core files. Load planning and
vendor reads force caching off, the five vendor-cache IO entry points compile
to disabled results, and vendor discovery/installation requires source JSON.
The macro-off conditional source text is equivalent to the pinned base after
ignoring whitespace; native desktop runtime validation is not claimed.

The real `vendor-cache-disabled-smoke.mjs` installs deterministic fixture JSON
under `/profiles`, links the vendor roots/directories into `/system`, and
checks successful JSON loading, no generated cache, no native cache opens,
malformed JSON rejection despite a valid cache, and cache-only vendor
exclusion after unlinking the root and directory. It preserves the raw source.
The 4,308-byte frozen cache fixture was generated using the pre-policy serial
artifact at the pinned core revision. A baseline positive control loaded both
Compatibility Alpha and Compatibility Beta after its root JSON was removed.
Its SHA-256 is
`cb912535465ee7d3affb905b5c61820a76097dd0ed90651da839af9e3bebdd14`.
If the upstream cache format changes, regenerate the positive-control fixture
and verify that it loads before using it to prove rejection.

Self-verification:

- `scripts\build-windows.bat quick --variant serial -j 4`: passed.
- `scripts\build-windows.bat quick --variant threaded -j 4`: passed.
- `pnpm --filter @orca/slicer-wasm vendor-cache-disabled-smoke`: passed.
- `pnpm --filter @orca/slicer-wasm vendor-cache-disabled-smoke:threaded`: passed.
- `scripts\build-windows.bat smoke --variant serial`: passed (slice, bridge,
  DRC, STEP).
- `scripts\build-windows.bat smoke --variant threaded`: passed (slice, bridge,
  DRC, STEP).
- `pnpm --filter @orca/slicer-wasm test`: 380 tests passed.
- `pnpm --filter @orca/slicer-wasm typecheck`: passed.
- Both build trees contain the macro on exactly the three intended source
  compile rules. Macro-off conditional-text equivalence: passed.
- Superproject and submodule `git diff --check`: passed.

Build output contains existing Boost macro/deprecation warnings and the
threaded memory-growth warning. No native desktop build or host E2E is run:
this piece changes WASM vendor policy, with no application/UI changes. Parent
independent acceptance reran both variant quick builds and both real
cache-disabled harnesses successfully, reviewed all three native diffs and
the build definitions, and confirmed the macro-off paths retain desktop logic.

### Step 3 — Resource layout and activation-aware startup

Change profile installation so core extracts directly into `/system` and all
vendor packages extract into `/profiles`. Continue fetching every package on
every application startup, preserving vendor-skip and core-failure behaviour.

Add Worker-side link management encapsulated behind the typed client. Always
link OrcaFilamentLibrary, then link each optional vendor's root JSON and whole
resource directory according to `models[].vendor`. Filament records must not
expand the optional vendor load set.

Load preferences and pass activation to the Worker before native profile
initialization. Replace unconditional `install_all_printers()` with conversion
of the saved activation into native profile configuration. Restore current
selections within the admitted candidates using the existing native rules.

**Validation:** every vendor is downloaded/extracted, while normal startup
parses only printer-enabled vendors plus the permanent library. Verify core
and library inclusion, stale records, missing vendors, first-use detection,
and initialization from saved activation after runtime recreation.

### Step 3 implementation and verification — 2026-10-09

The runtime downloads every package as before, delegates archive filesystem
writes to the typed client, places vendor files under `/profiles`, and keeps
core files under `/system`. Client-side link management establishes the
permanent library and only `models[].vendor` links. Filament names never expand
the vendor set. Rebuilding links preserves raw source files and core contents.
Missing vendor roots/directories are logged and skipped; core archive failure
continues to abort startup.

`SlicerClient.init(activation)` now requires an explicit `ProfileActivation`
or `null`. App startup loads preferences before passing that argument through
the existing Worker transport. There is no inference from remembered selected
printers and no old no-argument initialization adapter. The native options
require `profile_activation`; native initialization fills AppConfig before
loading presets, instead of enabling every parsed printer and filament. Normal
native visibility/default supplementation remains authoritative. Initialization
returns `setupRequired` for absent activation or no visible non-default printer.
The Step 7 UI gate is pending; this piece only establishes its startup contract.

Storage, client link management, and native initialization reject unsafe vendor
identities (separators, control characters, drive colons, blank names). A rejected
saved printer selection does not add vendor links or enable hidden models.
Runtime recreation receives the saved activation through the same startup path.

Existing native harnesses now explicitly request their installed JSON fixture
models and filaments through one test-only `fixtureProfileOptions` generator.
The fixture installer follows the new resource layout; the helper is not used
by production and does not restore implicit-all startup. Existing typed mock
callers likewise supply explicit fixture activation. Mock selection operations
respect admitted printer candidates. The Step 2 cache harness retains its
explicit activation across its deliberate malformed/unlinked-source checks.

Self-verification:

- Serial and threaded `scripts\build-windows.bat quick --variant <variant> -j 4`:
  passed after the final native vendor-validation changes.
- `pnpm --filter @orca/slicer-wasm profile-activation-startup-smoke` and
  `profile-activation-startup-smoke:threaded`: passed. Real evidence covers
  the permanent base (one built-in printer and library), whole-vendor parsing
  with only enabled model/nozzle visibility, excluded vendor non-parsing,
  stale/missing records, unsafe native identities, rejected remembered printer
  selection, and recreation with saved activation.
- `pnpm --filter @orca/slicer-wasm vendor-cache-disabled-smoke` and
  `vendor-cache-disabled-smoke:threaded`: passed after initialization migration.
- Threaded driver `scripts\build-windows.bat smoke --variant threaded`: passed
  on the final artifact (slice, bridge, DRC, STEP). Serial driver smoke and real
  serial `profile-compatibility-smoke.mjs` passed before the final stricter vendor
  path validation; final serial startup/cache smokes above were rerun successfully.
- `pnpm --filter @orca/slicer-wasm test`: 386 tests passed.
- `pnpm --filter @orca/slicer-runtime test`: 42 tests passed.
- `pnpm --filter @orca/platform-contract test`: 40 tests passed.
- `pnpm --filter @orca/slicer-app test`: 1,116 tests passed across 120 files.
- Web browser-adapter suite: 18 passed; Electron adapter suite: 30 passed.
- Typechecks for platform-contract, slicer-wasm, slicer-runtime, slicer-app,
  Web, and desktop: passed. Platform-contract import guard passed.
- Syntax checks on 62 migrated existing harness files passed. Only the native
  harnesses explicitly listed above were executed; the other migrated harnesses
  have not had their runtime semantics rerun in this step.
- `git diff --check` and all specification local links: passed.

No submodule changes are needed beyond Step 2's accepted pin. Host E2E is not
run in this piece: mandatory setup interaction is intentionally implemented in
Step 7. The fixture/mock suites and native startup tests do not claim rendered
first-use wizard or live activation-application acceptance. Parent independent
acceptance reviewed client FS ownership, activation-aware native initialization,
fixture migration and preference forwarding; reran startup smoke on both real
variants, serial cache smoke, 265 focused client tests, runtime/platform suites
(42/40 tests), and four affected package typechecks successfully. Final serial
standard driver smoke also passed during parent acceptance (slice, bridge, DRC,
STEP), closing the earlier final-artifact check gap. Spec links and JSON
examples passed review.

### Step 4 — Temporary full wizard catalogue

Create an independent temporary native `PresetBundle` on the existing Worker
and parse the complete `/profiles` set. Project printer models, nozzle variants,
default materials, and grouped filament candidates using Orca's explicit
compatibility mapping and grouping rules. Do not use the live project bundle
as the full catalogue.

Retain catalogue state only while the wizard is open. Closing destroys the
temporary bundle and projected data; reopening regenerates them from source.
The extracted resource tree remains available. Do not add a parsed catalogue
or lightweight between-opening cache.

**Validation:** catalogue opening and browsing do not change live selections,
project state, or `/system` links. Repeated openings generate equivalent
contents, and closing releases temporary catalogue allocations. Test loading
feedback and the prohibition on mid-load cancellation.

### Step 4 implementation and verification — 2026-10-09

`orc_open_setup_wizard_catalogue()` creates an independent `PresetBundle` from
all root JSON manifests in `/profiles`, with `OrcaFilamentLibrary` loaded first
and vendor errors logged/skipped by the native loader. Loading explicitly
passes `allow_cache=false`; the accepted Neo cache macro remains active.
Opening first destroys any prior wizard bundle/projection, then regenerates
both. Closing resets the owning `unique_ptr` and projected JSON; no catalogue
or source-vendor projection survives between openings. Raw resource files and
live `/system` links are retained.

The projection follows current Orca `GuideFrame::BuildProfileJson()` and
`resources/web/guide/22/common.js`: vendor models supply IDs, display names,
nozzle variants, and native-parsed default materials. System printer names map
to explicit vendor/model/nozzle identities. Resolved system filament settings
supply display manufacturer/type, and the trimmed name before `@` supplies the
group name. Every concrete member carries its canonical name and resource
vendor separately from its display manufacturer. Only `compatible_printers`
name mappings are projected, without evaluating workspace compatibility
expressions or filtering by current native visibility. Unknown printer names
produce no mapping; an empty mapping has Orca's unrestricted meaning. Resource
vendor membership will constrain UI eligibility in Step 7 and never expands
startup links.

Available model covers are Worker filesystem paths under `/profiles`, including
excluded vendors. The existing `readFilesystemFile()` client/Worker transport
reads their bytes without installing vendor links; missing covers are empty
paths for the UI placeholder. No additional image or fallback API is added.
The typed contract changes together and the mock provides a full deterministic
fixture catalogue. Preparation/application exports remain absent until Step 5.

Client and Worker admission reject closing or another opening while catalogue
loading is in flight, including at the sending endpoint before posting a
request. The gate clears on terminal responses, native/module errors, fatal
Worker failure, and transport posting failure. Loading feedback and menu/modal
presentation remain Step 7 UI work.

Self-verification:

- `scripts\build-windows.bat quick --variant serial -j 4` and the threaded
  equivalent: passed. The only subsequent native edit removes a blank line.
- `pnpm --filter @orca/slicer-wasm setup-wizard-catalogue-smoke` and
  `setup-wizard-catalogue-smoke:threaded`: passed. Real fixtures cover unlinked
  vendor models, inherited manufacturer/type grouping, library-first cross-vendor
  inheritance, explicit nozzle mapping, condition-only and unknown-name empty
  mappings, cover paths, skipped malformed vendors, repeated identical opens,
  reparsing source changes after close, and retry after directory-discovery failure.
  Full live profile, filament-session, native scoped configuration, model, plate,
  and nonempty Undo/history snapshots plus `/system` directory/link targets
  remain identical across successful and failed catalogue operations.
- `scripts\build-windows.bat smoke --variant serial` and the threaded equivalent:
  passed (slice, bridge, DRC, STEP).
- `pnpm --filter @orca/slicer-wasm test`: 392 passed. Coverage includes sender-side
  rejection before posting, Worker admission, direct-client failure release,
  full mock catalogue/state isolation, absent preparation/application exports,
  and excluded-vendor cover transport.
- `pnpm --filter @orca/slicer-runtime test`: 42 passed.
- Typechecks for slicer-wasm, slicer-runtime, slicer-app, Web, and desktop: passed.
- New native harness syntax check, `git diff --check`, and specification local
  links: passed.

Allocation lifetime is enforced by native ownership/destruction and verified
through source-change/reparse tests; allocator byte measurements and full-package
catalogue performance remain Step 8 work. No claim is made that linear-memory
capacity shrinks after closing. Host wizard UI/E2E is pending Step 7. Native
loading/application for Steps 5–6 has not been implemented in this piece.

Parent independent acceptance reviewed the native projection and ownership,
loading gates, cover-byte transport and isolation harness; both real catalogue
smokes, 33 focused Worker/client tests and client typecheck were rerun
successfully. A sender-side loading gate found during review was repaired and
verified before acceptance.

### Step 5 — Prepare, save, and apply

Implement this completion sequence:

```text
UI selection
  -> native validation and default-material supplementation
  -> normalized activation returned for persistence
  -> preference repository save
  -> native activation application
  -> application state refresh
```

The preparation phase constructs and validates a candidate bundle for the
target vendor set without mutating the live project. The normalized activation
must preserve the accepted stale-record policy. Keep prepared state within the
current wizard lifetime; it is not a reusable catalogue cache.

Only after saving succeeds, update the `/system` view and apply the prepared
native result to the running session. Complete validation and response-snapshot
preparation before replacing live state where practical, so failure handling
does not expose inconsistent selections. Do not call `orc_init()` for this
operation and do not introduce cross-storage/runtime rollback.

A save failure leaves live activation untouched and keeps the wizard open.
An application failure retains the saved record, reports failure, and permits
application retry. The next startup uses that saved record. The precise staged
bundle transfer and native publication mechanics must be resolved in this
piece and validated before its commit.

**Validation:** saving precedes application, persistence failure prevents
application, application failure preserves the saved record and history, and
retry succeeds without duplicate project mutations. Verify native defaults,
name resolution, and equivalence between the successfully applied candidate
set and the next normal startup.

### Step 5 implementation and verification — 2026-10-09

Preparation loads an independent bundle from `/profiles`, with
`OrcaFilamentLibrary` first and optional vendors derived only from selected
`models[].vendor`. Native AppConfig normalization deduplicates nozzle sets,
preserves stale model/material records, and supplements defaults from this
candidate bundle. Strict validation rejects unsafe vendor identifiers, malformed
records, and candidates without a usable visible printer. Preparation never
changes the live bundle, project, history, or `/system`. Reprepare invalidates
its previous candidate even when parsing fails; close releases prepared state.

The shared application completion helper prepares, saves through the existing
serialized preference-repository update, then applies. It preserves unrelated
preferences and prevents overlapping completion/retry operations from replacing
the candidate during a save. Preparation or persistence failure prevents
application. Application failure keeps the saved activation and prepared
candidate; retry applies without saving again. There is no storage rollback.
The typed client changes `/system` links only when apply is invoked after save;
a link-operation failure leaves native state unchanged and retry reconstructs
the saved view. Partial filesystem link changes are not rolled back.

Native application stages the target bundle and preserves project models,
plates, embedded profiles, project configuration, and available source edits.
It publishes actual profile, filament, plate, scoped-configuration, and history
snapshots through synchronized typed contracts. It does not call `orc_init()`.
Snapshots and serialized response allocation precede the irreversible history
publication. Failure restores the live bundle, selection pointers, sparse
drafts, filament IDs, plate revisions, lifecycle snapshots, history context,
and mutable/mesh capture caches; existing Undo/Redo and dirty state survive.

A necessary part of Step 6 was included here to make publication coherent:
successful application clears history to a new baseline, retaining prior dirty
state or an effective configuration change. Unavailable source drafts remain
sparse identities and overrides outside restorable history, and re-enabling a
source restores its draft. Project initialization/close/import clear these
session overlays, with import rollback restoring them. No full removed source
is retained solely for old history. Detailed remembered-rack, multi-extruder
colour, bed/spatial-transition, and broader plate-invalidation acceptance remain
Step 6 work; this record does not claim those regressions are complete.

The one-shot late-publication fault export follows the existing unguarded
`orc_test_inject_project_commit_failure` harness precedent. It has no typed
client, runtime, or application API and exists only for direct native harness
verification.

Successful checks:

- `scripts\build-windows.bat quick --variant serial -j 4` and the threaded
  variant passed; `scripts\build-windows.bat smoke --variant serial` and the
  threaded variant passed (slice, bridge, DRC, and STEP).
- `pnpm --filter @orca/slicer-wasm setup-wizard-activation-smoke` and its
  `setup-wizard-activation-smoke:threaded` counterpart passed. They cover strict
  prepare failure/live invariance, target-only supplementation, stale records,
  save/application boundary simulation, late-publication rollback with full
  snapshots and subsequent Undo/Redo, embedded override/model preservation,
  post-apply edit/Undo, dormant-source disable/re-enable, idempotent retry,
  dirty preservation, and next-startup candidate/system-view equivalence.
- `pnpm --filter @orca/slicer-wasm setup-wizard-catalogue-smoke` and its
  `:threaded` counterpart passed.
- `pnpm --filter @orca/slicer-wasm test`: 393 passed;
  `pnpm --filter @orca/slicer-runtime test`: 42 passed;
  `pnpm --filter @orca/slicer-app test`: 1,121 passed across 121 files.
  `pnpm --filter @orca/slicer-app exec vitest run src/setupWizard.test.ts`
  reran the five completion tests after final client fixture adjustments and passed.
- `pnpm --filter <package> typecheck` passed for `@orca/slicer-wasm`,
  `@orca/slicer-runtime`, `@orca/slicer-app`, `@orca/web`, and `@orca/desktop`.
- `node --check packages/slicer-wasm/harness/setup-wizard-activation-smoke.mjs`,
  `git diff --check`, and all eight local specification links passed validation.
  The pinned native submodule remained clean.

Initial compile errors in the editing-session accessor and collection pointer
initializer, a mock rack variable error, and a scalar draft fixture action were
corrected before final successful checks. Host wizard UI/E2E verification is
reserved for Step 7; full performance/release qualification is Step 8 work.

Parent independent acceptance reviewed target-only preparation, save ordering,
client link publication, staged bundle pointer ownership, sparse dormant drafts,
rollback caches and dirty-aware baseline replacement. Both real activation
smokes, 5 completion-helper tests, 34 Worker/client tests, and client/application
typechecks were rerun successfully. Diff checks passed before commit.

### Step 6 — Project transition and history baseline

Reuse Printer-transition, remembered-rack, compatibility-normalization,
source-draft, and colour mechanisms to apply activation to the existing
project. Preserve model and plate data and project-embedded configurations.
Replace unavailable active sources according to the accepted native rules.

Keep dormant source drafts as session identities and overrides; do not add
complete source presets solely for restoration of pre-application history.
Separate unavailable dormant overlays from history restoration paths that
require a resolvable source. Re-enabling an available source restores its own
draft under the existing draft policy.

After successful application, clear Undo/Redo and establish the resulting
project state as the new baseline. Preserve the correct dirty state separately
from history clearing. The existing `orc_history_reset()` marks the current
state as saved, so its implementation cannot be reused unchanged for this
operation. Synchronize history revisions and application-visible state.

Invalidate slice results only when effective slicing configuration changes;
otherwise preserve the existing dirty state and results. Failed application
must not clear history.

**Validation:** model/plate preservation, Printer and rack replacements,
colours, embedded profiles, dormant drafts, cleared Undo/Redo, correct dirty
state, and conditional slice invalidation. Exercise subsequent project edits
and Undo/Redo from the new baseline.

### Step 7 — Shared wizard UI and entry gates

Build the Printer and Filament pages with Neo's existing visual system and
the accepted Orca information structure. Implement grouping, default-material
selection, filters, search, visible-result bulk actions, and standard keyboard
controls. Material groups use the accepted two-state selection rule.

Add the single Setup Wizard menu entry and modal operation lock. Disable the
entry during conflicting operations and disable controls during catalogue
loading/application. Present save/application errors with retry.

Gate workspace entry on mandatory first-use completion and silently discard
file-open requests during that gate. Permit cancellation for menu-opened setup
when idle. New Project and runtime recreation use saved activation without
unnecessarily showing setup or initiating an extra New Project download.

**Validation:** mandatory completion, menu cancellation, disabled/busy states,
keyboard input, hidden-selection preservation, grouped selection expansion,
reopening, and both host entry/persistence boundaries.

### Step 8 — Integration acceptance and performance evidence

During each piece, run the directly affected tests and typechecks, adding
native quick-build/smoke for bridge or build changes. Before handoff, run root
unit tests and typechecks, quick-build both WASM variants, exercise a complete
real native contract on one variant and variant-specific startup/threading
smoke on the other, and cover affected Electron/Web host seams.

Prove the complete startup-to-wizard-to-application journey, persistence and
application failure paths, reopening, project preservation, and subsequent
slice/export. Use real WASM evidence for native loading and application;
mock UI tests alone do not establish those behaviours.

Measure full-package download/extraction separately from normal native loading,
first/repeated catalogue construction, and WASM memory before construction,
after construction, and after close. Verify temporary allocations are released
without requiring the heap's high-water capacity to shrink. Report measured
results rather than inventing timing or memory pass thresholds.

Update this specification's implementation/verification status with the
submodule commit, actual checks, measured results, and any unavailable checks.
Update roadmap documents only when delivered milestone status actually changes.

For further product clarification, explain current Orca behaviour and Neo's
choices together, resolve one question at a time, and update this specification
after a related group is settled.

## 6. Boundaries and verification

Application code uses the shared runtime. New direct Emscripten/FS operations
are encapsulated by the typed client on the Worker side. No wxWidgets GUI is
ported. Catalogue enumeration and activation must not reset the live project
through `orc_init()`, which clears project-related runtime state and history.
The staged preparation and save-before-apply mechanism is implemented in
Step 5. Detailed project-transition regression acceptance remains Step 6 work.

Existing serial-WASM exploration established that root JSON and directory
symlinks permit native vendor loading, that unlinked resource vendors do not
appear in startup printer candidates, and that removing links retains source
files. It also demonstrated that generated `.opc` files can keep a vendor
loadable after its links are removed. The cache macro is now implemented and built in both WASM variants;
the Step 2 record above contains the bounded verification evidence. This is bounded feasibility evidence, not feature
acceptance or cross-host/threaded verification.

Implementation verification must cover the startup vendor load set, permanent
core/library inclusion, printer-derived vendor inclusion, JSON-only loading,
reopening and cancelling the wizard, activation persistence, application failures,
successful-application history clearing, project-embedded configurations, and
the agreed existing-project and filtered-selection policies. Follow the repository
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
