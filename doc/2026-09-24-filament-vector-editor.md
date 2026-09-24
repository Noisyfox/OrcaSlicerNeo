# Filament vector editor

**Status:** Implemented and independently accepted
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

## Step 2 implementation evidence (parent accepted)

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

## Step 3 self-verification (parent acceptance pending)

The focused preset-editor Electron E2E now verifies both the mock path and the
real threaded-WASM path. In real mode it selects `Generic PLA @System` and
captures native defaults rather than assuming catalog values. It edits a
float (`filament_max_volumetric_speed`), int
(`filament_adhesiveness_category`), percent (`filament_shrink`), nullable bool
(`filament_adaptive_volumetric_speed`, Not set then Enabled), and closed enum
(`overhang_fan_threshold`). Opening the same source from another material slot
projects every typed value; `Reset preset` restores all original values; native
Undo/Redo restores the changed and reset snapshots; actual slot colours remain
unchanged. Existing Filament colour and multiline G-code assertions remain.
The real E2E found that Base UI displayed the nullable sentinel and numeric enum
value instead of their labels. The shared dialog now formats those selected
values as `Not set` / native enum labels, with a focused component assertion.

The reusable [real-WASM complex-project harness](../packages/slicer-wasm/harness/filament-vector-project-benchmark.mjs)
accepts module, project, output, and baseline/current mode paths on the CLI. It
compares raw serialized `set` with typed `set-element` for equivalent short
notes, escaped multiline long notes, and numeric edits; also covers note reads,
field reset, pure Move Undo/Redo, and draft Undo/Redo. Each mode imports the
project once. Warmups and measured scenarios restore the original note,
numeric value, and transform through Undo, then clear history before the next
scenario; project import/checkpoint setup is reported separately and excluded
from operation timing. Reports contain artifact/fixture hashes, warmup/sample
counts, response sizes, median and nearest-rank p95, separate `Module.ccall`,
UTF-8-copy, and JSON-parse intervals, and native history memory indicators.
The comparison fails on changed fixture/checkpoint identity, semantics, history
labels/counts, or exact `bytesUsed`. Output files contain no local project or
temporary paths.

Two sequential serial A/B runs used the same complex 3MF (45,586,816 bytes,
SHA256 `6db07e50b4692f95bfef65595e9fcd0bf902c9660b7b1d7bc1a4f98b4d7d2425`),
each with 3 warmups and 16 measured samples. The older baseline WASM hash was
`3e4db847481e6256c7220b7ead7b9fa13aeceee9d104dfaa6fe475fb2ec723fd`; the
current serial WASM hash was
`566faa684e3592e5d806b4daab5ac014654e3f40dccb799e680933a7595be1fe`. Both
runs report the same checkpoint fingerprint, semantic trace, history labels,
counts, and exact history-byte trace. History is 256 bytes at the checkpoint,
119,272,427 after the short note edit, 119,280,637 after the long note, and
119,332,850 after draft Undo and Redo; these values are identical in baseline
and current modes. The current response includes 33,531 additional bytes for
short-note operations and 39,951 additional bytes for long-note/numeric draft
operations, matching the extra returned editor projection. Move response sizes
and history storage are unchanged.

In the instrumented repeat, median baseline/current timings in milliseconds
were: short-note set 16.16/20.15, short-note read 3.10/6.86, long-note set
16.26/21.90, long-note read 3.27/7.38, numeric edit 69.29/74.55, numeric
reset 68.49/73.32, draft edit 68.14/74.25, pure Move 10.47/10.55, Move Undo
13.65/14.32, and Move Redo 10.30/11.07. For numeric edit the measured median
total delta was 5.26 ms, with 4.63 ms in the `Module.ccall` interval; UTF-8 copy and
JSON parse added 0.11 and 0.10 ms. These measurements do not isolate native
clone or validation costs. A first uninstrumented 16-sample run measured a
7.70 ms numeric-edit median delta, while its nearest-rank p95 moved from 74.59
to 100.57 ms; in the instrumented repeat the corresponding p95 values were
91.55 and 83.69 ms. The variable tails are retained in the raw reports and are
not treated as a stable p95 regression. Raw JSON and complete console logs are
kept outside the repository under `%TEMP%\orca-preset-perf-step3\` as
`baseline-3warm16.*`, `current-3warm16.*`, `baseline-timing-split.*`, and
`current-timing-split.*`. Parent source review confirms native history roots
retain `presetDraftRegistry` snapshot/revision and do not include editor
projections; the A/B history-byte trace is equal.

The loaded 1,009 Printer and 289 Filament source audit from Step 1 found no
real `floats_or_percents` binding. This gate therefore covers that control only
with the existing synthetic UI/contract fixture; it does not claim a real
catalog-backed edit for that native type.

Checks passed: `scripts\build-windows.bat quick --variant threaded -j 8`,
threaded `preset-draft-registry-smoke` (shared and independent overlays,
save/reload, dormant-draft omission and colour separation), `pnpm test` (989
tests across the eight workspace packages), and `pnpm typecheck`. Electron E2E
passed 1/1 with real threaded WASM and 1/1 with the mock runtime. The quick
threaded artifact has WASM SHA256
`e483b9c12e5c5509b4b4e2cd9eb7c7e828bb3bc3b68b56bfd2e6aca02c2726e0`. The
serial and threaded pinned C++ submodule remained untouched.

Parent repeat commands for the serial benchmark, run sequentially with no
build/test process active:

```powershell
$baselineModule = Join-Path $env:TEMP 'orca-filament-vector-baseline\orca_slice.js'
$complexProject = 'E:\OneDrive\Dokumente\3d打印\模型\奥德赛\OddseyHelmetFinalParts+(2)wholemorecolor-u1.3mf'
$outputDir = Join-Path $env:TEMP 'orca-preset-perf-step3'
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
node packages/slicer-wasm/harness/filament-vector-project-benchmark.mjs --module $baselineModule --project $complexProject --output (Join-Path $outputDir 'baseline-current-review.json') --mode baseline --warmups 3 --samples 16 2>&1 | Tee-Object -FilePath (Join-Path $outputDir 'baseline-current-review.log')
if ($LASTEXITCODE -ne 0) { throw 'baseline benchmark failed' }
node packages/slicer-wasm/harness/filament-vector-project-benchmark.mjs --module packages/slicer-wasm/out/serial/orca_slice.js --project $complexProject --output (Join-Path $outputDir 'current-current-review.json') --mode current --compare-report (Join-Path $outputDir 'baseline-current-review.json') --warmups 3 --samples 16 2>&1 | Tee-Object -FilePath (Join-Path $outputDir 'current-current-review.log')
if ($LASTEXITCODE -ne 0) { throw 'current benchmark or parity comparison failed' }
```

The threaded real-host E2E can be repeated with:

```powershell
$env:VITE_USE_MOCK='0'
$env:VITE_REAL_PROJECT_PROFILE='0'
$env:VITE_E2E='1'
$env:VITE_SCOPED_CONFIGURATION_GATE='1'
$env:VITE_SCOPED_CONFIGURATION_GATE_VARIANT='threaded'
pnpm exec node scripts/stage.mjs
pnpm --filter @orca/desktop exec electron-vite build --mode e2e
$env:ORCA_E2E_REAL='1'
pnpm --filter @orca/desktop exec playwright test e2e/preset-editor.e2e.ts
```

The mock E2E uses `VITE_USE_MOCK='1'` and leaves `ORCA_E2E_REAL` unset.

For serial host acceptance from PowerShell, stage the artifacts and pin the
desktop E2E build to the current serial WASM output:

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
staged renderer copy had the same size and hash. Step 2 used serial; Step 3
separately qualified the rebuilt threaded artifact.

## Independent final acceptance

The parent independently reran the complete benchmark in baseline/current order
with 3 warmups and 16 samples, with no compilation or tests active. Raw reports
and logs are under `%TEMP%/orca-preset-perf-parent/{baseline,current}.{json,log}`.
Fixture, checkpoint, semantic trace and every history label/count/byte state
matched exactly. Timings below include the synchronous native call and response
UTF-8 copy/JSON parse, excluding Worker transport and rendering.

| Operation | Baseline median / p95 ms | Current median / p95 ms |
| --- | --- | --- |
| Short notes set | 15.74 / 17.83 | 19.05 / 20.40 |
| Short draft read | 3.00 / 4.61 | 6.04 / 6.26 |
| Long notes set | 15.76 / 18.11 | 18.83 / 20.71 |
| Long draft read | 3.14 / 3.73 | 6.46 / 7.13 |
| Numeric edit | 65.89 / 72.46 | 66.63 / 73.66 |
| Numeric reset | 64.47 / 74.49 | 67.29 / 70.59 |
| Move Undo | 12.96 / 17.86 | 12.58 / 14.03 |
| Move Redo | 10.11 / 17.31 | 9.88 / 11.37 |
| Draft Undo | 29.41 / 35.06 | 28.81 / 30.22 |
| Draft Redo | 26.10 / 32.59 | 26.07 / 29.48 |

The additional response projection has measurable read/edit cost, around 3 ms
in this run; it does not enlarge native history or measurably slow restoration.
Other measured runs above show numeric-edit variance, so no zero-overhead claim
is made. Both raw sets and element sets use the same serialized history data.

Parent reruns of `pnpm test` (989 tests), `pnpm typecheck`, and real threaded
Electron `preset-editor.e2e.ts` (1 passed) also succeeded. Logs are
`%TEMP%/vector-parent-step3-{tests,types,e2e,build,stage}.log`.
The two review findings in Step 1 and two in Step 2 were corrected by their
respective agents before acceptance and before starting the next agent.
The full release matrix was intentionally not run for this focused repair.

## Acceptance record

- Step 1: accepted by parent after source review, independent WASM 182-test suite/typecheck and real preset draft smoke. Element updates clone one option; projections remain absent from history roots. Current bundled presets have no float-or-percent vector fixture (explicit coverage limitation).
- Step 2: accepted by parent after independent real serial Electron E2E (1 passed), app tests (646 passed), typecheck and source review. Review corrections cover all unbound vector types and typed field-reset values.
- Step 3: accepted by parent after independent source review, 3-warmup/16-sample complex-project A/B, real threaded E2E, full tests/typecheck and documentation checks. All three sequential gates are complete.
