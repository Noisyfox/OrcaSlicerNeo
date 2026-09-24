# Filament vector editor

**Status:** Implementation
**Date:** 2026-09-24

Governing inputs: [shared architecture](../spec/Web-Electron%20Shared%20Application%20Architecture.md),
[Preset Editor Dialog](../spec/Preset%20Editor%20Dialog.md), and
[testing guidelines](testing_guidelines.md).

## Accepted design

Native option storage types remain unchanged. Ordinary Filament vector fields
are edited as individual elements (default native index zero, never rack slot
index), matching Orca ConfigOptionsGroup. Genuine lists and structured options
retain explicit specialized/read-only presentation. Native metadata supplies
element types, GUI semantics and nullable information; the renderer does not
split serialized vector strings or infer vector cardinality from delimiters.

The bridge projects editor values and implements element updates by cloning
one effective option, changing the selected element, and serializing the full
option into the existing sparse draft registry. Other elements are preserved.
Raw stored values remain available to current consumers. Editor projections are
derived response data and must not be added to history roots or 3MF files.
There is no cross-version internal protocol fallback. Existing full-option
mutation remains a distinct operation for current native clients; element
mutation has explicit intent and validates index/type/value natively.

Cover float, int, bool, string, percent, float-or-percent and enum elements,
including nullable values and native escaping for multiline text/G-code.
True lists (including compatibility lists), points/groups and multi-variant
options must not be silently truncated. Reset semantics retain the existing
field/category/preset contract; all mutations still create one history entry.
Shared canonical source ownership, slot actual colours and native config
assembly remain unchanged. No pinned submodule changes.

The UI retains the existing desktop layout and uses existing shared controls.
Mobile remains deferred. Additional work is per-option/per-editor projection,
not model geometry; benchmark response size and history cost before handoff.

For Step 2, the ordinary Filament vector fields `filament_start_gcode`,
`filament_change_extrusion_role_gcode`, `filament_end_gcode`, and
`filament_notes` are editable through native element bindings and explicit
`set-element` mutations, using multiline controls where native metadata says
multiline. Printer scalar machine G-code remains read-only as specified; this
scope refinement does not enable other specialized controls.

## Sequential implementation and gates

Each step is assigned to a new implementation subagent. The subagent implements
and self-verifies, reports exact commands and results without committing. The
parent independently reviews and runs acceptance, then commits the accepted
step. No next step starts before acceptance. Corrections stay with that step's
agent until accepted.

1. Native projection, element mutation and strict typed-client contract.
   Tests: real native metadata, element preservation, invalid inputs, escaping,
   nullable/percent/enum semantics, source isolation, history and persistence.
   Gate: affected package tests/typecheck, serial quick build and focused real
   WASM harness; parent independently exercises native element/history paths.
2. Shared preset editor consumes native bindings and scalar editor values.
   Tests: real vector-shaped metadata, numeric/bool/text/enum/nullable controls,
   source/effective display, resets, shared-source state and actual colour
   preservation. Gate: app tests/typecheck and focused Electron E2E; parent
   independently verifies representative fields through the real runtime.
3. Reusable real-WASM UI and complex-project performance qualification.
   Implement any remaining in-scope fixes revealed by acceptance. Test both
   build variants, primary real host path, repository tests/typecheck and
   complex project get/edit/reset/Undo/Redo. Record fixture/artifact hashes,
   sample counts, median/p95, response size and history memory indicators;
   keep private fixture and raw machine-local evidence outside git.
   Gate: parent independently reruns the performance probe and reviews history
   storage/restore to confirm projections do not duplicate snapshot state.

## Step 1 implementation evidence (self-verified; parent acceptance pending)

The native draft response adds an `editor_bindings` map with scalar type,
native index and vector length, nullability, GUI type/flags, multiline/code/
read-only semantics, and typed source/effective element values. Closed native
enum vectors include their integer choices and labels; open string enums such
as `filament_type` retain `f_enum_open` and remain strings. Existing complete
serialized source/effective values and overrides remain unchanged. True
compatibility lists, serialized/plugin fields, identity metadata, points/groups,
the RammingDialog parameter string, and volumetric coefficient strings are not
projected as element zero.

`set-element` requires an explicit native index and scalar type, validates the
value and index, clones only the target source option, deserializes an existing
full-option override into that clone with substitutions disabled, and writes
its complete native serialization through the existing draft registry/history
transaction. It does not add editor projections to registry or history
snapshots. The existing full-option `set` action remains available.

Self-verification used the bundled `Generic PLA @System` source: element edits
preserved both elements of a two-value vector; integer and boolean edits were
written; bad index/type/value requests left history unchanged; nullable,
percent, closed-enum, open-enum, and escaped multiline text values round-tripped;
shared-source isolation, Undo/Redo, cached metadata stability, and ordinary
3MF save/reload passed. The current loaded catalog inventory was checked across
all 1,009 Printer and 289 Filament sources (all draft snapshots succeeded); none
exposes a `floats_or_percents` binding, so no real-profile `float_or_percent`
write case exists in these resources. Parent acceptance is still pending.

Checks passed: `pnpm --filter @orca/slicer-wasm test` (182 tests),
`pnpm --filter @orca/slicer-wasm typecheck`,
`pnpm --filter @orca/slicer-app typecheck`,
`pnpm --filter @orca/slicer-app test` (639 tests),
`scripts\build-windows.bat quick --variant serial -j 8`, and
`pnpm --filter @orca/slicer-wasm preset-draft-registry-smoke`.

Baseline: `%TEMP%/orca-preset-perf/final-serial.json` and scripts, prior serial
artifact hash `3e4db847481e6256c7220b7ead7b9fa13aeceee9d104dfaa6fe475fb2ec723fd`.
Odyssey fixture: 45,586,816 bytes, 14 objects/instances, 11 plates; SHA256
`6db07e50b4692f95bfef65595e9fcd0bf902c9660b7b1d7bc1a4f98b4d7d2425`.
Path: `E:\OneDrive\Dokumente\3d打印\模型\奥德赛\OddseyHelmetFinalParts+(2)wholemorecolor-u1.3mf`.

## Step 2 implementation evidence (self-verified; parent acceptance pending)

The shared dialog renders bound bool, integer, float, percent, float-or-percent,
closed numeric enum, open string enum, nullable, colour and multiline string
elements from native bindings, and submits explicit `set-element` requests.
Source/effective displays use typed projections when bound. Percent displays
retain percent semantics, float-or-percent keeps its separate unit flag, and
null remains distinct from empty text. It leaves whole serialized values to
existing consumers and mutations, uses `nozzle_diameter.elementCount` for
Printer template cardinality, and makes a missing required Filament G-code or
notes binding read-only. The complete `editorBindings` map remains mandatory;
there is no compatibility fallback for an absent map. Printer scalar machine
G-code remains read-only.

The mock module now reports native-shaped metadata and typed bindings for its
vector fixtures, applies one-element mutations while preserving neighboring
elements, includes typed state in mock history, and supports reset. App tests
cover typed requests and resulting values, typed source/effective projection,
neighbor preservation, null versus empty text, native enum semantics,
multiline G-code, and field/category/preset resets. The focused real-runtime
Electron E2E edits and resets the real Printer value and Filament colour/G-code,
checks shared canonical source and confirms both actual slot colours remain
unchanged. Its expectations capture the selected runtime's actual defaults;
the edited Printer value is selected inside its native min/max range.

Checks passed: `pnpm --filter @orca/slicer-app test` (643 tests), app
typecheck, `pnpm --filter @orca/slicer-wasm test` (183 tests), WASM typecheck,
desktop typecheck, CSS smoke, and focused real serial Electron E2E (1 test).
`git diff --check` passed. The mock does not parse serialized values in the UI;
its test-boundary fixture parser only handles the mock's native-shaped JSON
vectors. No additional UI component system was introduced.

For parent repeat acceptance from PowerShell, stage the artifacts and pin the
desktop E2E build to the current serial WASM output (do not use the stale
threaded artifact):

```powershell
pnpm exec node scripts/stage.mjs
$env:VITE_USE_MOCK = '0'
$env:VITE_REAL_PROJECT_PROFILE = '0'
$env:VITE_E2E = '1'
$env:VITE_SCOPED_CONFIGURATION_GATE = '1'
$env:VITE_SCOPED_CONFIGURATION_GATE_VARIANT = 'serial'
$env:ORCA_E2E_REAL = '1'
pnpm --filter @orca/desktop exec electron-vite build --mode e2e
pnpm --filter @orca/desktop exec playwright test e2e/preset-editor.e2e.ts
```

The serial WASM used by the passing E2E was 34,844,945 bytes with SHA256
`566FAA684E3592E5D806B4DAAB5AC014654E3F40DCCB799E680933A7595BE1FE`; the
staged renderer copy had the same size and hash. No threaded build was used.

## Acceptance record

- Step 1: accepted by parent after source review, independent WASM 182-test suite/typecheck and real preset draft smoke. Element updates clone one option; projections remain absent from history roots. Current bundled presets have no float-or-percent vector fixture (explicit coverage limitation).
- Step 2: accepted by parent after independent real serial Electron E2E (1 passed), app tests (646 passed), typecheck and source review. Review corrections cover all unbound vector types and typed field-reset values.
- Step 3: ready after Step 2 acceptance.
