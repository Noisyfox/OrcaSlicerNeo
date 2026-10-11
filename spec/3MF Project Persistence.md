# 3MF Project Persistence

**Status:** Approved — delivered 2026-09-04
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
- Project replacement follows the
  [Per-Plate Print lifecycle](Per-Plate%20Print%20Architecture.md#231-project-load-registry-construction-and-replacement-fence):
  cancellation before closing the old session preserves it. After close, a
  parse/load failure or cancelled compatibility warning leaves the fresh empty
  session; the closed project is not restored. Actual archive loading after
  close is non-cancellable in both WASM variants.

## Project-save behaviour

- **Save Project** writes an Orca/Bambu-compatible BBS 3MF file with the
  `.3mf` extension. It preserves model, object and part semantics, plate membership/layout,
  instance transforms, and eligible project/per-plate settings.
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
  session uses the project name **Untitled**. Geometry-only import preserves
  the current project's name and file identity, including an unsaved session.
- The suggested name for a first save or Save Project As… is
  `<project-name>.3mf`. A successful Electron save updates the session's
  project path and name. The Web host uses the same suggested download name
  without retaining an overwrite path.
- The shared session separately retains the actual opened or saved display
  filename, or no filename for a new unsaved session. Both hosts report the
  actual filename on successful save. This identity does not depend on an
  overwrite location or on whether the name is **Untitled**; it supplies the
  project basename for G-code naming. Cancelling or failing a save preserves
  the prior name and identity.
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
  names, instance transforms, and support, seam, fuzzy-skin, and multi-material
  painting. Editing and the stronger four-channel edit/save/reopen/Undo/Redo
  acceptance are governed by
  [Surface Painting Architecture](Surface%20Painting%20Architecture.md#92-required-adapter-editing-and-interoperability-acceptance).
  The four-channel adapter is delivered; the painting specification retains
  its exact interoperability and verification boundaries.

## Persistence scope

Multi-plate projects retain plate membership, layout and native per-plate
settings. Import/export normalization and the supported plate-count limit are
specified in [Multi-Plate Support](Multi-Plate%20Support.md); projects are not
flattened to one plate. Generated G-code and sliced-result packages remain
outside the editable project format. Unsupported sliced packages are rejected
without replacing the live session. A saved editable project must be re-sliced
before a result is exported or sent.

## Commands and navigation

- The File menu provides **New Project**, **Open Project…**, **Save Project**,
  and **Save Project As…**. **Add Model** remains an append-only geometry
  import operation and is not an alias for opening a project.
- The Open Project picker accepts only `.3mf` files. Supported model
  formats enter through [Add Model](Model%20Import.md), so selecting them cannot
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

The external fixture set is controlled by the
[compatibility manifest](../packages/slicer-wasm/fixtures/project-compatibility/manifest.json),
which pins repository, commit, path, URL, byte count, SHA-256, and AGPL-3.0
license. The [fixture acquisition harness](../packages/slicer-wasm/harness/acquire-project-fixtures.mjs)
fetches these archives on demand; they are not checked into this repository.
At the pinned commits, the OrcaSlicer and BambuStudio calibration archives
contain geometry without embedded project presets. They classify as `generic`
and establish geometry-only fallback, not embedded-settings interoperability.
A separately generated, self-saved BBS archive establishes the `bambu` path
with project settings. Retain this distinction when reporting compatibility
coverage; the baseline list above is not evidence of settings coverage from
every upstream sample.

## Long-running project operations

- Project open and save show stage-level progress and disable conflicting
  project commands. Save provides cancellation; open admits cancellation only
  before the old project session closes. The post-close archive load is
  non-cancellable in both WASM variants.
- Cancelling open before close preserves the current session. A cancelled
  compatibility warning or failed load after close leaves the fresh empty
  session, as required by the project-replacement lifecycle above.
- Project export completes into temporary WASM storage before bytes are passed
  to a host. A cancelled or failed export, or a cancelled host save dialog,
  leaves the existing destination file unchanged and leaves the current
  project dirty.

Project open and geometry-only 3MF import commit the progress dialog and give
the browser a paint opportunity before native parsing begins. The opening
state's frame callback must finish before loading starts. Completion follows
application of the project state, not merely return from parsing.

Both use the common asynchronous-task FIFO with stable native stages at 0, 10,
20, 55, 75, 90, and 100. Commit each event with its global sequence first;
after releasing the FIFO mutex, serial and threaded main-runtime producers
notify the guarded JavaScript consumer to drain the same FIFO until empty.
Pthread producers only advance the shared wake and never call JavaScript; the
main Worker consumes their events on its next poll. Both import paths use the
same typed Worker-client callback, with no project-load-specific side channel.
Native parsing remains synchronous on the stateful Worker. Moving parsing to a
pthread requires a separate ownership, commit, failure, and cancellation design.

Regression coverage must prove live delivery while the native call is active,
nested-enqueue FIFO order, pthread wake-only behavior, and the frame-callback
boundary before loading. Real Electron threaded and Web serial journeys must
render the dialog and a nonterminal native stage before the load result commits.

## Persistence boundary

The first release provides only explicit project open and save operations. It
does not add autosave, crash recovery, a recent-project list, or automatic
reopening of the last project at startup.

It also does not introduce product-level compressed-file or decompressed-archive
size quotas for 3MF input. Resource-limit policy is deferred; a runtime
resource failure after project closure leaves the fresh empty session under
the project-replacement lifecycle above.

Electron does not monitor or merge external changes to an opened project file
in this release. Save Project follows the Orca-style normal overwrite path;
only a write failure leaves the session dirty.

## Platform support

3MF project persistence targets the existing Electron desktop hosts and desktop
Chrome Web host. Mobile Web is unsupported and untested: the first release
makes no touch-input, mobile file-picker, drag-and-drop, or large-file memory
compatibility commitment.
