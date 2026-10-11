# Model Import

**Updated:** 2026-10-11

**Status:** Full threaded/serial wasm64 host integration delivered

**Scope:** Shared model additions, placement, and STEP/STP integration across
Electron and Web. DRC format details have their own linked specification.

## STEP and shared model-import behavior

- Both Electron and Web expose `.step` and `.stp` in the existing **Add Model**
  picker.  STEP import appends to the current scene; it never replaces it.
- Every successful Add Model operation switches the application to **Prepare**,
  regardless of the tab that was active when the operation started.  Picker,
  external model drops, and existing shared handy-model/scene Add Model
  callers use the same post-commit rule.  Cancellation and failure leave the
  active tab unchanged.  A model-drop batch that imports one or more files and
  then fails still switches to Prepare because the scene was successfully
  mutated; an empty/cancelled or wholly failed batch does not.
- External OS/browser drops of `.stl`, `.drc`, `.step`, and `.stp` use the same
  shared Add Model action and Worker/runtime path as the picker.  `.3mf` drops
  retain the existing Open Project path; unsupported files are consumed without
  navigation and text-only application drags remain available to their target.
  Browser and Electron model drops pass File bytes through the shared boundary;
  Electron opaque native paths remain limited to the existing 3MF project flow.
- Parsing and meshing run entirely in the existing Worker-hosted WASM session.
  No server, cloud conversion service, system CAD installation, or host file
  path crosses the platform boundary.
- The implementation uses OrcaSlicer's upstream OCCT-based `Format/STEP.cpp`
  and `Model::read_from_step()`.  STEP remains a CAD-to-triangular-mesh import;
  the resulting model can use the ordinary scene, transform, slice, preview,
  and project-persistence paths.
- A successfully imported STEP file becomes one model object named from the
  selected file.  Its imported solids become named volumes, matching the
  upstream STEP implementation's object/volume projection.  CAD assembly
  hierarchy beyond those volume names, colours, materials, GD&T, and other CAD
  metadata are not exposed in this delivery.
- Imported geometry is centred on the current plate and placed on the bed using
  the same non-project-file placement flow as STL and DRC.  Existing models
  remain in place; automatic arrangement and collision avoidance are out of
  scope.
- The first delivery uses the upstream default meshing values: linear
  deflection `0.003 mm`, angular deflection `0.5`, and no compound splitting.
  Picker and external model drops use the existing global project-operation
  progress dialog, titled **Importing model(s)**.  It is a non-cancellable,
  batch-level progress surface: a multi-file drop reports completed files and
  reaches 100% after the final file.  Native per-mesh progress is not exposed
  because the current runtime has no per-mesh progress callback.  No
  mesh-settings dialog or user cancellation control is exposed.
- The STEP reader honours source units and produces model coordinates in
  millimetres.  No application-side axis conversion, mirroring, or implicit
  scale is applied.
- Import is atomic.  A read, conversion, meshing, malformed-file, or
  out-of-memory failure leaves the live scene and any current slice result
  unchanged.  The user-visible error is **Unable to import STEP file**;
  detailed native diagnostics are logged in the Worker.


## Common import and scene commands

Add Model appends STL, DRC, STEP/STP and geometry-import content to the current
project. Clear Scene is a separate undoable operation. Imported models use the
current plate and native centering/bed placement; existing objects stay in
place. A 3MF opened or dropped as a project follows
[3MF Project Persistence](3MF%20Project%20Persistence.md), including the choice
between project replacement and geometry-only import.

DRC imports use the native Draco decoder; see
[DRC Import Support](2026-09-01-drc-import-support.md).
Primitives and bundled handy models follow
[Object List and Object Parts](ObjectList-and-Parts.md).

## Native build boundary

The pinned OCCT/XCAF dependency is compiled into both wasm64 variants.
The native STEP reader uses synchronous WASM-only dispatch and inline meshing
to avoid nested scheduler and serial-shim deadlocks. Native builds keep their
normal scheduler. Orca adaptations live in the committed core submodule;
external OCCT fixes belong to the scaffold dependency patches. Source units
become millimetres without a renderer axis conversion.

## Verification

Retain malformed-input atomicity, source units, multipart names, transforms,
slice/export and 3MF roundtrip coverage on both WASM variants. Host tests cover
picker/drop navigation and progress. Large-model limits and mobile support
are not inferred from the fixed fixture suite.
