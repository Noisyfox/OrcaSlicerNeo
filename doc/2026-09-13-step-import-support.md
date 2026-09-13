# STEP Import Support

**Date:** 2026-09-13

**Status:** In progress — OCCT wasm64 feasibility gate running

**Scope:** Add local `.step` and `.stp` model import to the shared OrcaSlicerNeo
Electron and Web application through the existing Add Model flow.

## Accepted product behaviour

- Both Electron and Web expose `.step` and `.stp` in the existing **Add Model**
  picker.  STEP import appends to the current scene; it never replaces it.
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
- Imported geometry is centred on the XY origin and placed on the bed using
  the same non-project-file placement flow as STL and DRC.  Existing models
  remain in place; automatic arrangement and collision avoidance are out of
  scope.
- The first delivery uses the upstream default meshing values: linear
  deflection `0.003 mm`, angular deflection `0.5`, and no compound splitting.
  It does not expose a mesh-settings dialog, import progress UI, or user
  cancellation control.
- The STEP reader honours source units and produces model coordinates in
  millimetres.  No application-side axis conversion, mirroring, or implicit
  scale is applied.
- Import is atomic.  A read, conversion, meshing, malformed-file, or
  out-of-memory failure leaves the live scene and any current slice result
  unchanged.  The user-visible error is **Unable to import STEP file**;
  detailed native diagnostics are logged in the Worker.

## Implementation decisions

- OCCT 7.6.0 is compiled from pinned source into both serial and threaded
  wasm64 slicer artifacts with the full XCAF path and Emscripten's FreeType
  port.  The pinned `packages/slicer-wasm/cpp/` submodule remains read-only;
  WASM adaptations, including the reproducible OCCT source fix, live in the
  scaffold and patch set.
- The upstream STEP reader's background-thread polling is replaced by a
  synchronous WASM-only execution path.  This preserves the Worker-only
  boundary and prevents the serial artifact's deferred Boost.Thread shim from
  deadlocking.  It is not a change to the global thread shim.
- The bridge keeps its extern "C", JSON-in/JSON-out contract.  The existing
  `orc_add_model` transaction explicitly dispatches `step` and `stp` to
  `Model::read_from_step()`; other formats retain their current loader paths.
- The shared application continues to call only the typed runtime/client API.
  Host adapters only widen their existing file-picker filters.
- OCCT licensing material, source provenance, and distribution notices are
  included with the feature before release, consistent with OCCT's LGPL-2.1
  licence and exception as well as the repository's AGPL-3.0 obligations.

## Feasibility gate and verification

Before production integration, an isolated probe must demonstrate that the
minimal OCCT STEP/XDE and meshing toolkits build and load a representative STEP
fixture in both serial and threaded wasm64 configurations.  It must also show
that upstream STEP code's internal threading behaves correctly in the serial
fallback.  A failed gate requires a new design decision before product code is
changed.

Verification will include focused client/action tests, serial and threaded
WASM quick-build plus STEP import/slice harness coverage, and real Electron,
Web-threaded, and Web-serial import-and-slice flows.  Fixtures cover a
millimetre part, an inch part, a named multi-solid assembly, and malformed
input; success asserts dimensions, object/volume naming, append semantics, and
non-empty G-code.

## Delivery sequence and acceptance gates

Each step is implemented by a fresh Luna High agent.  That agent completes the
step's implementation and all listed self-verification.  The root agent then
independently inspects the diff and repeats the relevant checks.  No later step
starts until the root acceptance passes and the accepted step is committed.

1. **Reproducible OCCT dependency build.** Add source fetch, SHA-256
   verification, the OCCT 7.6.0 Emscripten patch, and cmd-native plus shell
   variant builders.  The build stages the complete XCAF/STEP toolkit closure
   and FreeType consistently for serial and threaded wasm64.  Acceptance:
   clean staged source, both variant archive sets, no submodule modification,
   and a deterministic re-run using the normal build drivers.
2. **WASM core restoration and final link.** Restore STEP sources and OCCT
   linking in the scaffold, retain the existing dropped non-STEP OCCT features,
   and add the WASM-only synchronous STEP patch.  Acceptance: both `orca_slice`
   artifacts quick-build, validate as wasm64, and retain the existing STL, 3MF,
   and DRC harness behaviour.
3. **Atomic native STEP import.** Dispatch `.step` and `.stp` through
   `Model::read_from_step()` in the existing add-model transaction, with the
   accepted defaults and a compact licensed fixture/harness set.  Acceptance:
   both artifacts prove units, volume names, append semantics, malformed-input
   atomicity, and successful slicing of a STEP import.
4. **Shared client and host exposure.** Widen typed client/mock coverage and
   both host picker filters; map native STEP failures to the accepted generic
   user error without exposing native diagnostics.  Acceptance: focused client,
   shared-action, Electron-adapter, and Web-adapter tests plus package
   typechecks pass.
5. **Real-host and release integration.** Add focused real Electron and Web
   threaded/serial STEP import-and-slice journeys; install OCCT notices and
   provenance; update roadmap status only for delivered scope.  Acceptance:
   required Level-3 checks pass (`pnpm test`, `pnpm typecheck`, both quick
   builds, bridge smoke, and affected host E2E), with every unavailable check
   reported explicitly.
