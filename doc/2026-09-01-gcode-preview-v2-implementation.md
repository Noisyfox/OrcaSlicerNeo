# G-code Preview v2 implementation plan

**Date:** 2026-09-01
**Status:** B4 evidence recorded; release gate blocked pending external/native
and representative-hardware evidence
**Scope:** Repository-owned fixtures, Preview data v2, the shared Web/Electron
renderer, and the read-only Phase-C inspection increment

## Purpose and delivery rule

This is the living implementation record for the approved
[`G-code Preview v2`](../spec/G-code%20Preview%20v2.md) design. It turns that
design into seven independently testable steps. Each step is implemented,
self-verified, reviewed against its acceptance gate, and committed before the
next step starts. A failed gate stops the sequence; later steps must not work
around an unaccepted contract.

The first step (B0) establishes only reproducibility metadata and the fixture
manifest skeleton. It does not add preview implementation types, generated
G-code, screenshot files, binary models, or bridge changes. The existing cube
input remains the only real preview input until the later generation steps are
accepted.

## Accepted product constraints

- Phase B is the shipping foundation: explicit continuous segments, true
  camera-facing extrusion bands, layer range and move-end controls, Orca-style
  feature/line-type colouring and hide filters, travel visibility, dimmed
  earlier layers, a generic camera-facing nozzle marker, and the existing
  shell alpha/depth semantics.
- Phase C is read-only: the seven core schemes, preaggregated statistics,
  generic tool/nozzle inspection information, and a virtualised G-code text
  window. No pause, filament-change, custom-G-code, or other result mutation is
  introduced.
- All preview units are metric. Total cost is a bare decimal rounded to two
  places. Numerical ramps use the active result range and current Orca colours;
  user colour-ramp customisation is deferred.
- The native visual baseline is the clean
  `Noisyfox/OrcaSlicer` commit
  `b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde`
  (`version_2.4.0-12323-gb97ca3c0ac`). Dirty submodule files are never a
  reference. Changing this SHA requires an approved spec update.
- Web and Electron use same-renderer screenshot regression. Native captures
  are manually compared to the fixed reference; native OpenGL and browser
  WebGL are not pixel-diffed.
- `libslic3r` is reused as-is. Any native work is limited to the bridge/build
  scaffold and must not edit `packages/slicer-wasm/cpp` in place.

## Ownership and source boundaries

| Area | Owning path(s) | Boundary |
| --- | --- | --- |
| Fixture inputs and manifest | `packages/slicer-wasm/fixtures/preview-v2/` | Repository-owned metadata and reproducible inputs; no host paths |
| Preview bridge contract | `packages/slicer-wasm/src/bridge.cpp`, `bridge_buffers.*` | JSON metadata plus transferred structure-of-arrays buffers |
| Typed client and Worker transport | `packages/slicer-wasm/src/client/` | The only JS layer touching the Emscripten module |
| Runtime hand-off | `packages/slicer-runtime/src/slicer/` | Worker/runtime lifecycle; no renderer access to module URLs/globals |
| Shared state and controls | `packages/slicer-app/src/components/workspace/`, `src/stores/` | Host-independent React/Zustand behavior |
| Web/Electron integration | `apps/web/e2e/`, `apps/desktop/e2e/` and thin host entries | Cross-host acceptance only; no duplicate preview semantics |
| Native reference capture | `artifacts` listed by the manifest, kept out of source until approved | Orca checkout, profile, camera, viewport, theme, and capture provenance |

The manifest is descriptive scaffolding, not a TypeScript runtime contract. Its
fixture IDs and paths are stable review identifiers. B1 owns the actual
TypeScript/C++ data contract and may reject or extend metadata fields only with
an update to this record and the approved spec.

## Step sequence and acceptance gates

### B0 — fixture and reference baseline (this step)

**Ownership:** this document and
`packages/slicer-wasm/fixtures/preview-v2/manifest.json` (plus its local
README). Do not touch the C++ submodule, bridge, client, Worker, renderer, or
generated assets.

**Deliverables:**

1. Record the fixed native SHA and the clean-tree rule.
2. Register the command matrix, existing single-material cube, planned
   feature-rich and multi-material real slices, and the exact 250,000- and
   1,000,000-segment synthetic performance streams.
3. Record ownership, source/profile/config provenance, generation commands or
   an explicit `null` until a contract/generator exists, and the capture
   fields required before a reference is approved.
4. Keep expected counts and capture paths unset until the corresponding
   generator, bridge contract, and native capture actually exist.

**B0 gate:** the manifest parses; every required fixture ID is present exactly
once; the cube entry points to existing repository inputs and the pinned
profile name; planned entries contain no invented binary/artifact paths; the
README explains what is intentionally absent; no submodule pointer changes.

**Exact checks:**

```powershell
node --input-type=module -e "import { readFile } from 'node:fs/promises'; const p='packages/slicer-wasm/fixtures/preview-v2/manifest.json'; const m=JSON.parse(await readFile(p,'utf8')); if (m.nativeReference.commit !== 'b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde') throw new Error('wrong native SHA'); if (m.fixtures.length !== 5) throw new Error('fixture matrix changed'); if (new Set(m.fixtures.map(x => x.id)).size !== m.fixtures.length) throw new Error('duplicate fixture id'); console.log('preview-v2 manifest: OK');"
Test-Path packages/slicer-wasm/fixtures/cube.stl
Test-Path packages/slicer-wasm/fixtures/config.json
git diff --check
```

The first command is the focused B0 test. The two `Test-Path` checks verify
the only real input claimed by this step. A full `pnpm test` and
`pnpm typecheck` remain required before handoff even though B0 has no runtime
code changes.

### B1 — Preview data v2 bridge, client, and Worker

**Ownership:** `packages/slicer-wasm/src/bridge.cpp`,
`packages/slicer-wasm/src/bridge_buffers.hpp/cpp`,
`packages/slicer-wasm/src/client/{types,heap,client,worker}.ts`, their focused
tests, and the smallest necessary runtime forwarding in
`packages/slicer-runtime/src/slicer/`.

**Implementation contract:** replace endpoint-only preview data with explicit
continuous segments in structure-of-arrays buffers. Required arrays carry
start/end coordinates, layer ID, per-layer move order, source G-code ID, move
type, extrusion role, extruder/tool and colour-print ID, extrusion width, and
height. Metadata carries layer Z/ranges, palettes and result identity. Reserve
parallel optional arrays for feedrate, actual feedrate, volumetric/actual flow,
fan, temperature, pressure advance, acceleration, jerk, time, and layer
duration; omit unavailable arrays. Reserve preaggregated feature statistics and
source-line mapping without copying full G-code text. Every transferred
buffer has an explicit ownership/lifetime rule and is transferable exactly
once.

**Tests and gate:** add mock-module contract tests for continuity, lengths,
layer/move indexes, palettes, optional-array omission/presence, metadata and
transfer ownership; add serial and threaded real smoke assertions when
artifacts are available. No JSON object per move is allowed.

```powershell
pnpm --filter @orca/slicer-wasm test
pnpm --filter @orca/slicer-wasm typecheck
scripts\build-windows.bat quick
node packages/slicer-wasm/harness/run-slice.mjs --module packages/slicer-wasm/out/serial/orca_slice.js --stl packages/slicer-wasm/fixtures/cube.stl --config packages/slicer-wasm/fixtures/config.json
node packages/slicer-wasm/harness/run-slice.mjs --module packages/slicer-wasm/out/threaded/orca_slice.js --stl packages/slicer-wasm/fixtures/cube.stl --config packages/slicer-wasm/fixtures/config.json
```

B1 passes only when both variants expose the same typed contract, the focused
tests and real smoke are green (or a documented toolchain blocker is recorded),
and the existing v1 result path remains green. B2 cannot start on a mock-only
contract.

#### B1 implementation record

The bridge now emits `preview_version: 2` with explicit continuous segments
(`start`/`end` xyz plus layer, per-layer move order, source G-code id, move
type, extrusion role, tool, colour-print id, width and height) in parallel
typed buffers. The result metadata carries result identity, source filename,
layer ranges/Z values, feature palette, and source-line availability without
copying G-code text. The bridge exposes all metrics available from the pinned
`GCodeProcessorResult`; the client treats each metric as optional and omits it
when its pointer is absent. The typed client copies each heap allocation and
frees it exactly once. Worker responses transfer each distinct ArrayBuffer once
and retain compatibility aliases for the pre-v2 endpoint client until B2's
renderer migration.

Mock fixtures cover segment continuity, array lengths, layer/move indexes,
palettes, optional metric omission/presence, metadata, and Worker transfer
ownership. `bridge-smoke.mjs` asserts the same v2 fields against both real
serial and threaded artifacts.

Actual B1 verification (2026-09-01):

- `pnpm --filter @orca/slicer-wasm typecheck` — passed.
- `pnpm --filter @orca/slicer-wasm test` — passed (78 tests).
- `git diff --check` — passed.
- `scripts\\build-windows.bat quick` — passed; rebuilt/staged threaded and
  serial wasm64 artifacts.
- `node packages/slicer-wasm/harness/run-slice.mjs --module packages/slicer-wasm/out/serial/orca_slice.js --stl packages/slicer-wasm/fixtures/cube.stl --config packages/slicer-wasm/fixtures/config.json` — passed.
- Same `run-slice.mjs` command with `out/threaded/orca_slice.js` — passed.
- `node packages/slicer-wasm/harness/bridge-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js packages/slicer-wasm/fixtures/cube.stl` — passed, including v2 SoA/continuity/metric assertions.
- Same `bridge-smoke.mjs` command with `out/threaded/orca_slice.js` — passed,
  including v2 SoA/continuity/metric assertions.

The full workspace `pnpm test` and `pnpm typecheck` remain parent-level release
checks. No native G-code result is claimed beyond the two bridge smoke runs.

### B2 — GPU extrusion-band renderer and chunking

**Ownership:** `packages/slicer-app/src/components/workspace/viewport/`
(renderer, geometry/material helpers, chunk cache and focused unit tests),
with only the B1 result adapter changes needed in `useSliceResult.ts` and
`Scene.tsx`.

**Implementation contract:** build camera-facing bands from segment width and
height, keep geometry GPU-resident while camera uniforms change, and use
layer-aligned chunks with nearby-layer caching for large streams. Range,
filter, dimming, and colour updates use uniforms or visibility buffers. The
active inspection range always retains true geometry. Model shells remain at
alpha 0.15 and paths remain visible through them.

**Tests and gate:** deterministic command-matrix rendering tests verify band
width/height, layer chunk boundaries, active-range preservation, and that
camera rotation/pan/zoom does not rebuild path geometry. Performance harnesses
consume exactly 250,000 and 1,000,000 synthetic segments and report FPS,
memory/chunk behavior, and rebuild counts on the representative integrated-GPU
target. B2 does not add controls or Phase-C information.

```powershell
pnpm --filter @orca/slicer-app test
pnpm --filter @orca/slicer-app typecheck
pnpm --filter @orca/slicer-app test -- viewport
```

B2 passes when the renderer tests prove no camera-triggered reconstruction,
both performance fixtures exercise layer chunks, and ordinary/large targets
meet 60/30 FPS without reducing the active range. If hardware cannot be
measured, record the exact machine and a blocked performance gate; do not
claim compliance from a mock renderer.

**B2 self-verified implementation:** `ToolpathLines` now renders instanced rectangular
extrusion bands instead of `LineSegments`. Segment start/end, width, height,
and palette colour are GPU attributes; the vertex shader derives a
camera-facing side vector and keeps physical width/height in world units.
`useSliceResult` builds layer-aligned chunks once per completed result and
disposes them when that result is invalidated. Camera movement changes only
the normal Three.js camera uniforms. The existing single-layer scrubber
continues to select the active layer until B3 introduces the dual-thumb
range. Nearby layer chunks may be GPU-resident cache entries, but B2 never
makes them visible during camera gestures: without B3's wider visible range,
camera-only state changes preserve the existing active single-layer
selection. The active layer is never reduced. Empty and legacy v1 aliases
fall back safely to zero/compatibility data, and the renderer remains
host-independent for Electron and Web. `ToolpathBandCache` identity tests
cover false → true → false camera gesture state without rebuilding or
replacing geometry for the same slice result.

**B2 verification:**

- `pnpm --filter @orca/slicer-app test -- toolpathBandGeometry useSliceResult` — passed, 2 files / 5 tests.
- `pnpm --filter @orca/slicer-app test` — passed, 35 files / 235 tests.
- `pnpm --filter @orca/slicer-app typecheck` — passed.
- `pnpm test` — passed across all workspace packages.
- `pnpm typecheck` — passed across all workspace packages and hosts.
- `pnpm --filter @orca/desktop test:e2e` — passed, 24 tests; 3 existing intentional skips.
- `git diff --check` — passed.

The exact 250,000- and 1,000,000-segment synthetic streams are exercised by
the chunking test, including total-count preservation and layer-aligned
partitioning. This environment has no representative 2020-era integrated
GPU measurement path; the 60/30 FPS and GPU-memory requirements remain an
open B4 release gate, and no hardware compliance is claimed here.

### B3 — Phase-B controls and inspection semantics

**Ownership:** shared workspace viewport controls and state in
`packages/slicer-app/src/components/workspace/viewport/`, related stores, and
shared CSS. Host E2E specs live in `apps/desktop/e2e/` and `apps/web/e2e/`.

**Implementation contract:** add the right-edge inclusive dual-thumb layer
range, bottom single-thumb active-layer move-end control (the layer start is
implicitly visible), Feature/Line Type legend with Orca hide semantics, global
travel visibility, dimming toggle, and a generic
camera-facing nozzle marker at the active end move. Reset all ephemeral state
on a new slice. Preserve viewport focus/Tab behavior and Up/Down,
Left/Right, Shift/Ctrl acceleration, `L`, and theme behavior.

**Tests and gate:** unit tests cover ranges, empty/single-layer bounds,
filters, travel, dimming, reset and keyboard focus. Electron and Web E2E cover
slice → legend hide/show → ranges → marker → theme, using the same fixture
IDs. Screenshot regression captures are same-renderer only; native comparison
uses the B0 manifest.

```powershell
pnpm --filter @orca/slicer-app test
pnpm --filter @orca/slicer-app typecheck
pnpm --filter @orca/desktop test:e2e
pnpm --filter @orca/web test:e2e:threaded
pnpm --filter @orca/web test:e2e:serial
```

B3 passes only when both hosts agree on control semantics and resetting a new
result cannot render stale paths. No Phase-C scheme or G-code text window may
be required for this gate.

#### B3 implementation record

The shared preview state now owns ephemeral inclusive visible-layer and
active-layer move-end state; the active layer's path is implicitly visible from
move zero through that end. Feature/Line Type visibility, global travel
visibility, previous-layer dimming, single-layer mode, and the default
Feature/Line Type scheme. A completed slice initializes the active end at the
last layer/move; invalidation and a new result reset all preview choices and
remove stale toolpath data. No preview state is persisted.

The canvas overlay provides Orca-style right-edge layer and bottom move
controls, a feature legend with hide semantics, travel and dimming toggles,
and a single-layer toggle. Empty and single-layer results retain valid
bounds. The overlay uses theme-aware surface/text tokens while palette colors
remain semantic and stable. Viewport focus supports Up/Down and Left/Right
inspection stepping, Shift/Ctrl acceleration, and `L`; text inputs, overlay
controls, and normal Prepare bindings retain their existing focus behavior.
Changing the active layer atomically replaces the move bound with that layer's
local maximum and resets the inspection end to a valid position, so keyboard
and layer changes cannot retain a move index from another layer.

Single-layer inspection retains the dual-thumb vertical layer control: either
thumb moves the active layer and both endpoints stay paired at that layer. The
move bound is replaced with the newly active layer's local maximum on each such
change; leaving single-layer inspection restores layers zero through the active
layer.

**B3 specification correction (2026-09-02):** the bottom Move control is a
single-thumb move-end slider, not a dual-thumb range slider. The active layer's
toolpath is visible implicitly from its first move; there is no separately
operable move-start thumb. The correction applies to the approved product
behavior and its shared Web/Electron tests; the vertical layer control remains
dual-thumb.

**B3 layout correction (2026-09-02):** the right-top Feature/Line Type
overlay is inset from the canvas's right edge by a dedicated gutter for the
fixed dual-thumb layer slider. The overlay and slider must have disjoint
`getBoundingClientRect()` rectangles at desktop sizes, including with a long,
scrolling legend, so the gutter cannot intercept either layer thumb. The
shared desktop and Web E2E suites verify the separation and keyboard operation
of the layer control at a compact viewport.

Filtering and dimming update prebuilt per-instance GPU attributes. Camera
gesture state is not a geometry or visibility-cache input, so camera movement
continues to reuse the prepared chunks. The generic Phase-B marker is a
camera-facing sprite at the last move at or before the active move end.

Actual B3 verification (2026-09-01):

- `pnpm --filter @orca/slicer-app test` — passed (37 files, 246 tests).
- `pnpm --filter @orca/slicer-app typecheck` — passed.
- `pnpm test` — passed across all workspace packages.
- `pnpm typecheck` — passed across all workspace packages and hosts.
- `pnpm --filter @orca/desktop test:e2e` — passed (25 passed, 3 existing
  intentional skips).
- `pnpm --filter @orca/web test:e2e:threaded` — passed (real Web slice flow).
- `pnpm --filter @orca/web test:e2e:serial` — passed (real Web serial slice
  flow).
- `git diff --check` — passed.

Both host suites now exercise the dedicated B3 overlay contract after a real
slice: legend hide/show, travel visibility, layer controls, marker presence,
and theme-token stability. Shared tests additionally cover inclusive ranges,
empty bounds, travel/feature hiding, dimming, reset, local move normalization,
marker selection, keyboard focus and renderer buffer reuse. No Phase-C scheme,
G-code text window, or external-G-code path is included.

### B4 — Phase-B integration, native comparison, and release gate

**Ownership:** integration wiring in shared app/runtime, fixture generation
outputs approved by the manifest, screenshot test configuration, and CI
commands. Do not duplicate bridge logic in either host.

**Activities:** generate/record the feature-rich and multi-material real
slices, capture native Orca references from the fixed clean checkout, and
populate counts, camera poses, ranges, themes, browser viewport and approved
capture paths only after B1–B3 pass. Run the complete dual-variant bridge,
Web, and Electron matrix. Review native captures manually for layout,
colours, dimming, ranges and information density; record reviewer/date and
the exact source SHA.

```powershell
pnpm test
pnpm typecheck
scripts\build-windows.bat quick
node packages/slicer-wasm/harness/run-slice.mjs --module packages/slicer-wasm/out/serial/orca_slice.js --stl packages/slicer-wasm/fixtures/cube.stl --config packages/slicer-wasm/fixtures/config.json
node packages/slicer-wasm/harness/run-slice.mjs --module packages/slicer-wasm/out/threaded/orca_slice.js --stl packages/slicer-wasm/fixtures/cube.stl --config packages/slicer-wasm/fixtures/config.json
pnpm --filter @orca/desktop test:e2e
pnpm --filter @orca/web test:e2e:threaded
pnpm --filter @orca/web test:e2e:serial
```

B4 is the Phase-B release gate. It passes only when all existing regressions,
both real WASM variants, both hosts, performance targets, same-renderer
screenshots, and the manually reviewed fixed-reference comparison pass.
Phase C must not begin before this gate is accepted.

#### B4 implementation record

The manifest now records one reproducible real bridge probe for the
feature-rich-single-material entry. It uses the existing repository cube STL,
the pinned `Bambu Lab P1P 0.4 nozzle` profile, and
`feature-rich-single-material.config.json`; it is deliberately marked
`verified-real-probe-not-full-fixture`, not approved as the planned dedicated
feature-rich fixture. The probe runner installs the real profile packages,
selects the printer through the bridge, slices through the real serial or
threaded WASM module, reads the v2 result, and frees all result buffers. It
does not retain G-code or screenshots. Both variants matched exactly:

The follow-up B4 harness fix also releases the bridge's v1 compatibility
`vertex_ptr`, `layer_ptr`, and `feature_ptr` allocations. A pointer-address set
deduplicates these frees against v2 primary arrays, so both independent and
future aliased bridge layouts are safe.

- 12,718 G-code lines, 21,609 preview segments, and 100 layers;
- feature roles `[1, 2, 4, 5, 6, 7, 10, 18]`;
- move types `[1, 2, 3, 4, 8, 9, 10]`; and
- one tool/color-print id (`[0]`).

The probe proves real perimeter/infill/solid/top roles and travel/control
data, but not support/bridge output and not a dedicated feature-rich model.
The multi-material entry remains `blocked`: the current public bridge has no
object/part extruder assignment operation, and no repository-owned two-colour
fixture exists. The existing real smoke and probe both observe only
`extruders=[0]`, `colorPrints=[0]`; no multi-material artifact is claimed.

Native comparison is also blocked with evidence preserved in the manifest.
The submodule is at the fixed clean-reference SHA
`b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde`, but its working tree contains
pre-existing changes in six `src/libslic3r` files and no native OrcaSlicer
executable exists in the checkout. No reset, checkout, build, or capture was
attempted. Therefore no native screenshot path, hash, reviewer, or approval
is recorded. The browser/Electron screenshot evidence remains same-renderer
behavior checks only; no cross-renderer pixel diff is used.

The exact B4 verification run on 2026-09-01 produced the following results:

- `pnpm test` — passed (all workspace packages; slicer-app 37 files / 246
  tests, slicer-wasm 78 tests, and all host/runtime suites green).
- `pnpm typecheck` — passed (all workspace packages and hosts).
- `scripts\\build-windows.bat quick` — passed; threaded and serial wasm64
  artifacts rebuilt/staged with emcc 6.0.6.
- `node packages/slicer-wasm/harness/run-slice.mjs --module packages/slicer-wasm/out/serial/orca_slice.js --stl packages/slicer-wasm/fixtures/cube.stl --config packages/slicer-wasm/fixtures/config.json` — passed (100 layers, 13,234 lines).
- Same `run-slice.mjs` command with `out/threaded/orca_slice.js` — passed
  (100 layers, 13,234 lines).
- `node packages/slicer-wasm/harness/bridge-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js packages/slicer-wasm/fixtures/cube.stl` — passed.
- Same `bridge-smoke.mjs` command with `out/threaded/orca_slice.js` — passed.
- `node packages/slicer-wasm/harness/preview-v2-real-fixtures.mjs --module packages/slicer-wasm/out/serial/orca_slice.js --fixture feature-rich-single-material` — passed with the probe counts above.
- Same real-fixture command with `out/threaded/orca_slice.js` — passed with
  identical counts/categories.
- `pnpm --filter @orca/desktop test:e2e` — passed (25 passed, 3 existing
  intentional skips).
- `pnpm --filter @orca/web test:e2e:threaded` — passed (1 real Web flow).
- `pnpm --filter @orca/web test:e2e:serial` — passed (1 real Web serial
  fallback flow).
- `git diff --check` — passed before the evidence commit.

The existing host E2E suites exercise same-renderer preview screenshot/pixel
change assertions around layer scrubbing and camera gestures, plus the B3
overlay contract. There is no approved golden screenshot set yet, so this
record does not claim full screenshot approval.

Performance measurement was attempted at the evidence level but cannot be
claimed: the repository's deterministic chunking tests cover exactly 250,000
and 1,000,000 segments, while no real browser FPS harness is connected to
those streams. The measured machine is Windows with an NVIDIA GeForce RTX
3080 (driver `32.0.16.1088`) and AMD Ryzen 9 5900X (24 logical processors),
not a representative 2020 integrated-GPU laptop. No 60/30 FPS result or
GPU-memory compliance is asserted. A future gate must add a real browser
benchmark and run it on the stated representative target.

Accordingly, B4 is evidence-complete but release-gate blocked by the
dedicated feature-rich fixture, multi-material fixture/assignment path,
native clean executable/capture, approved screenshot baseline, and
representative-GPU performance measurement. No C1 work is included or
unblocked by this record.

### C1 — Phase-C schemes and preaggregated statistics

**Ownership:** B1 metadata/optional arrays, Worker aggregation in
`packages/slicer-runtime/src/slicer/`, and shared scheme/legend/statistics
components under `packages/slicer-app/src/components/workspace/`.

**Implementation contract:** support Feature/Line Type, Filament/Tool, Speed,
Volumetric Flow, Layer Time, Temperature, and Fan Speed. Metric min/max comes
from the active result. Multi-material uses configured actual filament colours;
single-material defaults to Feature/Line Type. Statistics are computed before
the UI opens and include total estimated time, filament length/weight, bare
two-decimal cost, and per-feature standard time/filament. Missing source data
omits the field or scheme rather than inventing values.

**Gate commands:**

```powershell
pnpm --filter @orca/slicer-runtime test
pnpm --filter @orca/slicer-app test
pnpm --filter @orca/slicer-runtime typecheck
pnpm --filter @orca/slicer-app typecheck
```

C1 passes when command-matrix, single-material and multi-material fixtures
prove all seven schemes, result-range legends, palette identity, statistics
and metric omission, with no UI-thread full-path scan.

### C2 — inspection card and virtualised G-code text linkage

**Ownership:** shared read-only inspection components and chunked source-text
API in `packages/slicer-wasm/src/client/`, Worker/runtime forwarding, and
shared E2E tests. No host-specific text implementation.

**Implementation contract:** the generic 3D nozzle/tool marker gains a
native-style card with available layer/Z, X/Y/Z, move type, feature, source
line and selected-scheme values. The text window is virtualised plain text
with active-line highlighting. Slider/move changes select the matching line;
an unmappable line selects the nearest preceding mappable move, otherwise
leaves inspection unchanged. Full G-code is fetched only on demand in chunks.

```powershell
pnpm --filter @orca/slicer-wasm test
pnpm --filter @orca/slicer-runtime test
pnpm --filter @orca/slicer-app test
pnpm --filter @orca/slicer-wasm typecheck
pnpm --filter @orca/slicer-runtime typecheck
pnpm --filter @orca/slicer-app typecheck
pnpm --filter @orca/desktop test:e2e
pnpm --filter @orca/web test:e2e:threaded
pnpm --filter @orca/web test:e2e:serial
```

C2 passes when two-way mapping, nearest-preceding behavior, virtualization,
chunking and focus-safe `C` shortcut are covered in both hosts. It must not
introduce result mutation or pause/change markers.

### C3 — Phase-C release and full regression

**Ownership:** integration/CI and manifest-approved captures only. Update this
same document with accepted counts, capture approvals, and actual command
results; do not create a second implementation diary.

```powershell
pnpm test
pnpm typecheck
scripts\build-windows.bat quick
node packages/slicer-wasm/harness/run-slice.mjs --module packages/slicer-wasm/out/serial/orca_slice.js --stl packages/slicer-wasm/fixtures/cube.stl --config packages/slicer-wasm/fixtures/config.json
node packages/slicer-wasm/harness/run-slice.mjs --module packages/slicer-wasm/out/threaded/orca_slice.js --stl packages/slicer-wasm/fixtures/cube.stl --config packages/slicer-wasm/fixtures/config.json
pnpm --filter @orca/desktop test:e2e
pnpm --filter @orca/web test:e2e:threaded
pnpm --filter @orca/web test:e2e:serial
```

C3 passes only when C1/C2 unit, contract, performance, visual, Web threaded +
serial, and Electron checks are green; all release artifacts identify the
fixed native SHA; and the final manual native comparison is approved. Any
known intentional skip is named in this document before release.

## Fixture ownership and generation strategy

The manifest under `packages/slicer-wasm/fixtures/preview-v2/` is the single
index. Every entry has an owner, source kind, profile/config provenance,
generation command, expected-count placeholders, and artifact retention
policy. Paths are repository-relative or absent; absolute local paths are
never accepted.

The command matrix is generated in a later B1 test helper from the accepted
Preview data v2 contract. It must exercise every Phase-B category, travel,
layer/move boundary, width/height variation, and every Phase-C optional metric.
It is deterministic and small, but is not evidence that a real slicer output
works.

The existing cube STL/config is the compact real fixture. Its exact printer
profile is `Bambu Lab P1P 0.4 nozzle`; the existing profile resource source is
the authority for the remaining process/filament selection. The feature-rich
and multi-material inputs are repository-owned assets generated by later
steps, with attribution and license notices beside them. They may not be
replaced by an external download at test time.

Performance streams are generated in the renderer test package with exact
segment counts of 250,000 and 1,000,000 and deterministic layer-aligned
partitions. Their generator records the seed, layer count, segment count and
chunk size in the manifest; no generated binary is checked in unless startup
time or CI reproducibility proves it necessary.

Generated G-code is retained only for deterministic text/source-line tests.
Screenshots are retained only when they are approved regression evidence.
Otherwise the manifest records a command that regenerates them from the
fixed source/profile/camera tuple.

## Native reference capture manifest requirements

Before any capture is approved, the manifest entry must contain:

- native repository URL/name, exact clean commit SHA and Orca version string;
- model fixture ID, profile names, profile package/version and complete config
  provenance;
- capture ID/state (`planned`, `captured`, or `approved`), generator command,
  host OS/GPU/driver and capture timestamp;
- camera position, target, up vector, projection/zoom and active layer/move
  ranges;
- theme, browser/native window viewport in CSS/device pixels, pixel ratio,
  colour scheme, filters, travel visibility and dimming state;
- expected command/segment/layer counts once produced, with units and source;
- relative paths plus SHA-256 for retained G-code or images, and reviewer/date
  for manual approval; and
- an explicit statement that the capture is compared manually to the fixed
  native baseline and not asserted through cross-renderer pixel diff.

Unknown values stay `null`; a capture with missing provenance is not approved.

## Current known constraints and risks

- The working tree intentionally has unrelated dirty changes inside
  `packages/slicer-wasm/cpp`; B0 must preserve them and must not change the
  submodule pointer.
- The current bridge/client exposes v1 endpoint buffers, so no B0 fixture may
  claim v2 segment counts or source-line metadata yet.
- Emscripten and both wasm64 artifacts may be unavailable on a development
  machine. Real smoke/build gates are then blocked, not replaced by mock-only
  claims; CI or an emsdk machine must supply the evidence.
- Native Orca OpenGL and browser WebGL differ in fonts, drivers and
  rasterisation. Manual comparison is required and direct pixel equality is
  intentionally prohibited.
- Feature-rich support/bridge/overhang output is profile- and model-sensitive;
  the generator must record the exact profile and verify emitted categories
  rather than assuming every native version emits all categories.
- A million-segment stream can exceed browser/GPU memory. Chunking may reduce
  detail outside the active range, never inside it; tests must measure this
  policy rather than silently lower all geometry.
- Metric arrays may be absent in valid source results. UI and legend behavior
  must treat omission as unsupported data, not zero.
- Multi-material profiles and actual colours can drift with upstream profile
  resources. The fixture pins profile provenance and cannot rely on a user's
  installed profile set.

## B0 state

B0 establishes the manifest and this executable plan. No Phase-B bridge,
renderer, controls, or Phase-C implementation is accepted by this record yet.
The next step is B1, and it may start only after the B0 gate and this commit
are independently accepted.
