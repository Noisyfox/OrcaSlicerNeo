# 3MF Project Persistence

**Status:** Approved — implementation basis; release verification in progress
**Scope:** Single-plate 3MF project open/save in the shared Electron and Web application.

## Project-open behaviour

3MF project opening follows the current OrcaSlicer load-behaviour policy.

- The saved preference is one of **Load All**, **Ask When Relevant**,
  **Always Ask**, or **Load Geometry Only**. The default is **Ask When
  Relevant**.
- **Load All** opens the selected 3MF as a project: it replaces the current
  project and restores eligible project settings.
- **Load Geometry Only** imports only model geometry and layout, appending it
  to the current scene without replacing the current project settings.
- **Ask When Relevant** shows a choice only when the current scene already
  contains a model; otherwise it opens the selected 3MF as a project.
- **Always Ask** shows a choice for every selected 3MF.
- The choice presents **Open as project** and **Import geometry only**;
  **Import geometry only** is the initial selection. Cancelling leaves the
  current session unchanged.
- Opening as a project first applies the normal unsaved-work and modified
  preset protections before replacing the current project. Importing geometry
  only does not replace the existing scene.

## Project preferences

- **Preferences…** is available from the File menu on every host, including
  macOS, and opens a shared lightweight modal dialog.
- In the first release, this dialog contains only **Project Load Behaviour**:
  Load All, Ask When Relevant, Always Ask, or Load Geometry Only.
- This is a global user preference, not a project setting. It is persisted
  through the existing cross-host preferences repository.

## Compatibility and fallback

- The application identifies whether a 3MF carries supported Orca project
  settings, BambuStudio project settings, generic 3MF geometry, or settings
  that cannot be safely restored by this application version.
- A generic 3MF, missing project settings, unsupported settings, or an
  incompatible project version falls back to geometry-only import following
  the current OrcaSlicer policy.
- The application presents the reason for that fallback. It does not request
  an additional confirmation before continuing.
- A compatibility fallback after the user chose **Open as project** still
  replaces the current project; it omits only the unavailable project
  settings. Geometry is appended only when the user explicitly chose
  **Import geometry only**.
- A failed parse or cancelled operation is atomic: the current session stays
  unchanged.

## Project-save behaviour

- **Save Project** writes an Orca/Bambu-compatible BBS 3MF file with the
  `.3mf` extension. It preserves the single-plate model, object and part
  semantics, instance layout, and eligible project settings.
- Normal project saves do not embed a slice result, G-code, or thumbnails.
  G-code export and send-to-printer remain independent operations.
- Electron provides **Save Project** and **Save Project As…**. Save Project
  overwrites the current project file when the host has an in-memory source
  path; Save Project As… selects a new path.
- When Electron's Save As target already exists, the native file dialog's
  normal overwrite confirmation is used. A cancelled dialog or failed write
  leaves the session and its dirty state unchanged.
- The Web host provides **Save Project** as a new `.3mf` download on every
  invocation. It does not attempt to overwrite a previously downloaded file.
- The project file path is host-private, in-memory session data. It is not
  stored in shared preferences or made available to the shared application.

## Project identity and unsaved changes

- An opened project uses its source-file base name as its project name. A new
  session or a geometry-only import uses the project name **Untitled**.
- The suggested name for a first save or Save Project As… is
  `<project-name>.3mf`. A successful Electron save updates the session's
  project path and name. The Web host uses the same suggested download name
  without retaining an overwrite path.
- Model and layout changes, object-structure changes, project-setting changes,
  and preset-selection changes mark the project as having unsaved changes.
  Geometry-only import also marks the existing session as changed.
- Before opening another project or creating a new project from a dirty
  session, the application offers **Save**, **Don't Save**, and **Cancel**.
  Cancel leaves the current session unchanged. Electron provides the same
  choice before closing a dirty session.
- In the Web host, selecting Save starts the project download and then
  continues the requested internal operation. Browser download APIs cannot
  verify that the user retained the downloaded file.
- Browsers cannot offer that three-way choice during tab close, reload, or
  navigation. For these Web lifecycle events, the application uses the native
  browser leave/cancel confirmation; leaving never triggers an automatic
  project download.
- An unexported slice result or generated G-code is not part of project dirty
  state and adds no confirmation to New, Open, or close. It may be discarded
  and sliced again later.

## Project configuration and presets

- Valid project settings are retained in the WASM project session, participate
  in slicing, and are preserved on a later project save even when the current
  UI has no control for a setting. Edits through supported UI controls overlay
  those retained values.
- Unrecognized, invalid, or incompatible settings follow the compatibility
  fallback policy rather than being silently discarded.
- Embedded printer, process, and filament presets are available only for the
  lifetime of the opened project. The application restores their project
  selection when applicable, but never installs them into system profiles or
  global preferences.
- Project preset selections and edits are project-scoped and are saved with
  that project. Opening a project does not overwrite the user's last-used
  system-profile preference. Leaving the project restores that global
  preference; only selection changes made outside a project session update it.
- Geometry-only import does not apply the selected file's project settings.
  It retains the session's active printer, process, filament, and project
  configuration; imported model object and part configuration is cleared
  except for its extruder assignment.
- The first save of an Untitled or geometry-only session writes a secure,
  complete snapshot composed from the current printer, process, project, and
  filament configurations. Print-host addresses, API keys, passwords, and
  other connection credentials are excluded from that snapshot.
- When restoring embedded presets, the application warns if the project
  contains modified printer or filament G-code, or if its corresponding system
  preset cannot be found. The warning allows the user to continue for that
  load and to remember the warning preference, following OrcaSlicer's safety
  behaviour.
- Valid project-level custom G-code settings, including layer-change, pause,
  and colour-change instructions, are restored, participate in re-slicing,
  and are saved with the project. They are distinct from an already generated
  G-code result, which remains outside the first-release project format scope.
- The application preserves, on a best-effort basis through the upstream model
  and BBS 3MF reader/writer, model semantics that the first-release UI may not
  edit: multipart and modifier relationships, printable state, object and part
  names, instance transforms, and support, seam, and multi-material painting.

## First-release boundaries

- A source project with multiple plates loads all parseable model objects and
  their stored coordinates into the application's single shared scene. Objects
  from other source plates may therefore appear outside the active bed.
- The application does not retain source plate membership or per-plate data.
  Saving such a loaded project writes a single-plate project. The application
  informs the user when the multi-plate project is first loaded and again
  before it is saved in this flattened form.
- 3MF files that embed G-code or a sliced-result package are unsupported in
  the first release. The application reports that the file type is unsupported
  and leaves the current session unchanged.

## Commands and navigation

- The File menu provides **New Project**, **Open Project…**, **Save Project**,
  and **Save Project As…**. **Add Model** remains an append-only geometry
  import operation and is not an alias for opening a project.
- The Open Project picker accepts only `.3mf` files. STL, OBJ, and other mesh
  formats continue to enter through Add Model, so selecting them cannot
  accidentally replace the current project.
- The application supports `Ctrl/Cmd+N`, `Ctrl/Cmd+O`, `Ctrl/Cmd+S`, and
  `Ctrl/Cmd+Shift+S` for New, Open, Save, and Save As respectively. The Web
  host prevents the browser's default page-open and page-save actions for
  these commands.
- Once the runtime is ready and no slice or project operation is running,
  New Project, Open Project, and Preferences are available. Save Project is
  available only for a dirty session. Save Project As is available whenever
  the current session has project content, including a clean opened project,
  so it can create a copy immediately.
- A successful New Project or Open Project operation selects the Prepare
  workspace. Save and Save As do not change the active workspace.
- Selecting a `.3mf` through **Add Model** always performs geometry-only,
  append-only import. It does not show the project-load choice or restore
  project settings.
- When the load-behaviour policy requires a choice, the application asks
  whether to open the file as a project or import geometry before it asks for
  dirty-project confirmation. Only choosing Open as project can replace the
  current session and therefore trigger the Save/Don't Save/Cancel prompt.
- Dropping a `.3mf` file onto either the Electron or Web application is an
  Open Project entry point. It uses the same load-behaviour policy,
  compatibility fallback, and dirty-session protections as the File menu's
  Open Project command.
- Operating-system `.3mf` file association and double-click-to-launch or
  wake the desktop application are outside the first-release scope.
- For a multi-file Open Project selection or drop containing `.3mf` files,
  files are processed in deterministic filename order. The first `.3mf` uses
  the project-load behaviour; later `.3mf` files and any other model files
  are imported as geometry-only additions. Thus opening the first file as a
  project replaces the session before the remaining geometry is added, while
  choosing geometry-only appends every file.
- Unlike the upstream's partial-batch edge case, cancelling the first file's
  project-load choice cancels the complete multi-file operation without
  importing any later file.

## Compatibility verification

The first release's automated compatibility baseline covers:

- a BBS 3MF saved by this application and reopened using both serial and
  threaded WASM variants;
- project 3MF files produced by the fixed upstream OrcaSlicer version;
- BambuStudio project 3MF files; and
- PrusaSlicer or generic 3MF geometry imported through the geometry-only
  compatibility fallback.

Cross-host end-to-end coverage verifies project open, save, dirty-state
protection, and Web download behaviour.

### Release-gate evidence (2026-09-04)

The external fixture set is controlled by
`packages/slicer-wasm/fixtures/project-compatibility/manifest.json`. It pins
the upstream repository, commit, path, URL, byte count, SHA-256, and AGPL-3.0
license for OrcaSlicer, BambuStudio, and PrusaSlicer samples. Archives are
acquired on demand by `harness/acquire-project-fixtures.mjs`; they are not
checked into this repository. The OrcaSlicer and BambuStudio samples are
upstream calibration geometry without embedded project presets at the pinned
commits, so the bridge correctly reports `generic` and the harness verifies
geometry-only fallback. A generated self-saved BBS archive is separately
verified as `bambu` with project settings available.

Evidence currently available on Windows:

- `pnpm test`: pass (8 workspace projects; 553 tests).
- `pnpm typecheck`: pass.
- `scripts\\build-windows.bat quick`: pass; threaded and serial artifacts
  rebuilt and staged.
- `scripts\\build-windows.bat smoke`: pass for the existing dual-variant
  bridge smoke suite.
- `node harness/project-roundtrip.mjs --module out/serial/orca_slice.js`:
  pass, including self-save/reopen, Bambu compatibility, structure retention,
  and invalid-input atomicity.
- `node harness/project-compatibility.mjs --module out/serial/orca_slice.js`:
  pass for all three pinned fixtures and geometry-only fallback.
- `pnpm --filter @orca/desktop test:e2e`: pass, 28 passed and 3 intentional
  platform/real-runtime skips.

The following remain explicit CI/release gates and are not marked delivered:

- `node harness/project-roundtrip.mjs --module out/threaded/orca_slice.js`
  and the threaded project compatibility harness currently abort during the
  native geometry-only project load after the first fixture on this machine.
- `pnpm --filter @orca/web test:e2e:threaded` and
  `pnpm --filter @orca/web test:e2e:serial` each run 1 passing and 1 failing
  test. The failure is the existing `web.e2e.ts:95` strict locator assertion
  (the layer scrubber intentionally contains two range inputs); it is not
  represented as a compatibility pass.

CI/release must provision or acquire the three manifest archives, run
`--check`, run both real WASM variants' round-trip and compatibility harnesses,
and run both real Web E2E commands before changing this spec or the roadmap to
delivered.

## Long-running project operations

- Project open and save show stage-level progress, disable conflicting project
  commands, and provide a cancellation action.
- Cancellation of an open operation leaves the current session unchanged.
- Project export completes into temporary WASM storage before bytes are passed
  to a host. A cancelled or failed export, or a cancelled host save dialog,
  leaves the existing destination file unchanged and leaves the current
  project dirty.

## Persistence boundary

The first release provides only explicit project open and save operations. It
does not add autosave, crash recovery, a recent-project list, or automatic
reopening of the last project at startup.

It also does not introduce product-level compressed-file or decompressed-archive
size quotas for 3MF input. Resource-limit policy is deferred; a runtime
resource failure still follows the atomic open-failure rule.

Electron does not monitor or merge external changes to an opened project file
in this release. Save Project follows the Orca-style normal overwrite path;
only a write failure leaves the session dirty.

## Platform support

3MF project persistence targets the existing Electron desktop hosts and desktop
Chrome Web host. Mobile Web is unsupported and untested: the first release
makes no touch-input, mobile file-picker, drag-and-drop, or large-file memory
compatibility commitment.
