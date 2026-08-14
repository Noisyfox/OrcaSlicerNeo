# M3 Implementation Notes — Packaging & Hardening

Scope: the record a fresh engineer needs for the M3 milestone (design Phase F):
what was delivered (Tasks 1–8 of `doc/2026-08-14-m3-packaging-hardening-plan.md`),
the packaged-app asset pipeline, the e2e modes and env contracts, the CI
matrix layout, and every deferral with its verification path. Companion to the
approved design, `spec/Grand Plan.md`, and `doc/high_level_dev_plan.md`.

## Packaged-app asset pipeline

> **2026-08-14: the renderer origin changed from `app://` to loopback http.**
> Out-of-process dedicated workers (the only kind since the
> `PlzDedicatedWorker` flag was removed in Electron 36) cannot fetch their
> scripts from custom schemes (electron#38774), and the wasm64 module forces
> Electron ≥ 35. Prod main now serves `out/renderer` over
> `http://127.0.0.1:<ephemeral port>` (Host-validated, path-guarded).
> See `doc/2026-08-14-http-origin-for-workers.md` for the full story,
> evidence, and security posture. The rest of this section is the M3-era
> record of the scheme that preceded it.

- **Runtime model (M3-era).** Prod main served the renderer over the
  privileged `app://` custom protocol, not `file://` (Chromium hard-blocks
  worker scripts from file:// — opaque origin). `registerSchemesAsPrivileged`
  declared `app` with standard/secure/supportFetchAPI/corsEnabled at module
  top; inside `whenReady`, `protocol.handle('app', …)` served
  `out/renderer`. Prod loaded `app://bundle/index.html`; dev keeps the
  `ELECTRON_RENDERER_URL` branch. **Superseded 2026-08-14** — the scheme,
  the `protocol` import, and `registerSchemesAsPrivileged` are gone from
  main.
- **Electron 32+ dedicated-worker regression (M3-era).**
  `app.commandLine.appendSwitch('disable-features', 'PlzDedicatedWorker')`
  worked around dedicated workers failing to load from custom schemes (and
  file://) — script served, worker never runs (electron#43556, #47374). The
  flag is removed in Electron 36; the appendSwitch is gone from main and the
  workaround is dead (see the http-origin note for the replacement).
- Worker factory URL (`slicer.worker.ts`): `import.meta.env.PROD ?
  '../wasm/orca_slice.js' : '/wasm/orca_slice.js'`. Dev: Vite serves the
  renderer `public/` dir at `/`. Prod: the worker chunk lives in
  `out/renderer/assets/`, and the relative specifier resolves against its
  module base URL → `/wasm/orca_slice.js` (origin preserved). The chunk is
  emitted as an IIFE (Vite default `worker.format`) but constructed
  `{type:'module'}` — valid; base-URL resolution is format-independent.
  Emscripten loads `.wasm`/`.data` from its scriptDirectory, which inside a
  worker derives from the WORKER script's URL (`assets/`), not the imported
  module's — the factory must pass `locateFile` → `../wasm/` (prod) /
  `/wasm/` (dev). Without it the packaged probe 404s on
  `assets/orca_slice.data` (the harness never hits this: Node resolves
  from the module itself).
- `asarUnpack: out/renderer/wasm/**` — the ~70 MB `.data` preload bundle is
  read on app start; unpacking skips asar decompression. Main's fs reads are
  asar-aware either way — with the http origin the served files come from
  inside app.asar transparently.
- `scripts/stage-wasm.mjs` stages `orca_slice.{js,wasm,data}` into
  `apps/desktop/src/renderer/public/wasm/` (gitignored) → `out/renderer/wasm/`
  at build. Packaging runs stage:wasm first; CI downloads the one artifact.
- `e2e/stub/orca_slice.js` + `scripts/stage-stub-wasm.mjs`: plain-JS
  bridge-shaped module used ONLY by the packaged-app probe
  (`e2e/packaged.e2e.ts`) to exercise the packaged app:// wasm URL path
  without emsdk.

## COOP/COEP under app:// (M4 SharedArrayBuffer headroom)

- M2's session-level `webRequest.onHeadersReceived` header mutations are
  version-dependently ignored on custom-protocol responses
  (electron#20730, #45168) — under `app://` those headers ARE the M4
  SharedArrayBuffer headroom, so the fix is to set COOP/COEP directly on the
  `protocol.handle` Response (currently the response sets only
  `content-type`).
- Upgrade track: CVE-2026-34767 / GHSA-4p4r-m79c-wq3v (custom protocol +
  webRequest, Electron < 38.8.6) and the `PlzDedicatedWorker` flag removal
  in Electron 36 → plan the E34→E36 upgrade explicitly.

## e2e modes and env contracts

- `pnpm --filter desktop test:e2e` — `electron-vite build --mode e2e`
  (`.env.e2e` sets `VITE_USE_MOCK=1`) then Playwright; expects the mock gcode
  marker `; mock gcode (unit-test fixture)`; runs anywhere, no emsdk.
- `pnpm --filter desktop test:e2e:real` — plain build (real module; run
  `node scripts/stage-wasm.mjs` first) + `ORCA_E2E_REAL=1`; expects `G1`
  moves in the exported file; CI job `e2e-real`.
- `ORCA_E2E=1` (main process): `openFileDialog`/`saveFileDialog` return fixed
  paths from `ORCA_E2E_MODEL` / `ORCA_E2E_EXPORT` — Playwright cannot drive
  native dialogs. `writeFile` is real; the spec reads the exported file.
- Spec asserts (mock): preset select visible → status `Ready` → slice
  disabled → open model → slice enabled → slice → status `Sliced` →
  viewport + layer scrubber visible → export enabled → file exists with
  marker. Test ids: `preset-select`, `slicer-status`, `btn-open`, `btn-slice`,
  `btn-export`, `viewport`, `layer-scrubber`.
- Packaged probe (`e2e/packaged.e2e.ts`): `stage-stub-wasm` → `package:dir`
  → spec asserts `preset-select` visible — the worker's dynamic import
  succeeded under the packaged `app://` scheme — and no renderer
  `pageerror`s. It runs with the STUB module (`e2e/stub/orca_slice.js`
  staged by `scripts/stage-stub-wasm.mjs`) and is NOT in CI; the pre-release
  spot-check swaps `stage-stub-wasm.mjs` for `stage-wasm.mjs` — the probe
  reads whatever is in `public/wasm`, so the same spec exercises the real
  module.

## CI matrix (.github/workflows/ci.yml)

- `wasm` (ubuntu-latest, emsdk 6.0.4 — the design doc's risk-table version):
  fetch-deps → build-boost-wasm64 → build.sh → run-slice smoke →
  bridge-smoke → upload `orca_slice.{js,wasm,data}` (retention 7 d). This is
  the FIRST real execution of the M2-deferred WASM build + binary-buffer
  bridge verification. Dep cache keyed on the three script SHAs.
- `unit`: install → `pnpm -r test` → `pnpm -r typecheck` → desktop build.
- `e2e-mock`: `xvfb-run -a pnpm --filter desktop test:e2e` (no emsdk).
- `e2e-real`: downloads the artifact → stage:wasm → build → `xvfb-run` with
  `ORCA_E2E_REAL=1`.
- `package` matrix (no arm runners; electron-builder downloads the arm64
  Electron dist): windows-latest → `--win` (x64+arm64 NSIS), ubuntu-latest →
  `--linux` (x64+arm64 AppImage), macos-14 → `--mac --x64` (2026-08-14:
  macos-13 runners were retired — the x64 DMG now builds on the arm64
  macos-14 runner; electron-builder downloads the x64 Electron dist, same
  cross-build the win job already does), macos-14 → `--mac --arm64`. All
  six bundle the same staged artifact; installers uploaded (retention
  14 d), unsigned. The windows job emits THREE artifacts: electron-builder
  26.15.3 eagerly cross-builds x64 + arm64 plus a combined multi-arch
  `-win.exe`; the upload glob `release/*.exe` covers all three.
- Env hygiene: CI must NOT set `WASM_PROFILES_DIR` — the default full
  profiles tree is exactly what CI validates (the override exists for
  lighter local builds only). `ORCA_E2E_REAL=1` is set only on the
  `e2e-real` job.
- Known first-run iteration surface (AGENTS.md loop): TBB_HEADERS /
  DROP_PATTERNS / stubs / bridge API drift; ~14 GB runner disk vs the
  ~50 GB-class boost build — the dep cache makes it first-run-only.

## Full preset bundle

- `--preload-file "$WASM_PROFILES_DIR@/system"` (default
  `cpp/resources/profiles`, 72 MB) replaces the M1 curated `--embed-file`
  subset. Mount unchanged (`/system`) → harnesses and `orc_init` untouched.
  With the full tree every third-party filament `inherits` chain resolves, so
  the M1 fixpoint filter is gone and `orc_init`'s preset counts jump to ~75
  vendors (vs the M1 BBL-curated subset). Startup: `.data` streams into
  MEMFS and the heap grows (ALLOW_MEMORY_GROWTH; INITIAL_MEMORY 64 MB stays).
  `stage-wasm.mjs` hard-requires `orca_slice.data` (missing → exit 1).

## Licensing

- Root `LICENSE`: canonical AGPL-3.0 text (fetched from gnu.org).
- Root `SOURCE_OFFER.md`: repository URL, branch, submodule pin, build
  pointers (AGPL §13).
- NSIS installer shows the license page (`nsis.license` in
  electron-builder.yml); `license` fields on both package.jsons.
- TRAP: `nsis.license` points at `AGPL-3.0.txt` — a byte-identical copy
  (`cmp`-verified) of the root LICENSE in `apps/desktop/build/`. The plan's
  original `../LICENSE` path FAILS under electron-builder 26: the license
  resolves against the build-resources dir (`apps/desktop/build/`) and the
  project dir (`apps/desktop/`), not the config dir, so `../LICENSE` lands
  at `apps/LICENSE` and `package:win` hard-fails at `computeLicensePage`.
  Do not "restore" it — it breaks the windows build.

## Slice cross-check (deferred)

- Procedure + script shipped: `scripts/crosscheck-slice.mjs <wasm.gcode>
  <desktop.gcode>` — PASS/FAIL on: G1 moves present, layer count equal,
  total filament within 5%. Executed manually on an emsdk machine with
  desktop OrcaSlicer:
  `node packages/slicer-wasm/harness/run-slice.mjs --module packages/slicer-wasm/out/orca_slice.js --stl packages/slicer-wasm/fixtures/cube.stl --config packages/slicer-wasm/fixtures/config.json`
  then desktop headless `orca-slicer --export-gcode --output out.gcode
  --load <profile.ini> cube.stl` — same model + profile. Tolerances, not
  byte equality: the module pins a different libslic3r SHA than desktop.
  Expected first-difference candidates: version-stamped header metadata
  only (dropped features are excluded from the build entirely).
- Note: the script's `TIME_RE` (`/; total estimated printing time .* =
  (\d+)/`) captures only the hours digit on real lines like
  `; total estimated printing time ... = 2h 3m 45s`; the parsed value is
  currently unused and the regex is plan-owned.

## Deferred verification (first CI push / emsdk machine)

- WASM rebuild + run-slice + bridge-smoke (no emsdk locally) — CI `wasm` job.
- e2e with the real module — CI `e2e-real` job.
- Six-target packaging (win x64 verified locally; arm64 + linux + mac are
  matrix builds) — CI `package` job.
- Slice cross-check — emsdk machine + desktop OrcaSlicer (manual).

> **2026-08-14: local WASM build brought up on the dev box (24 cores).**
> The "no emsdk locally" deferral is resolved: emsdk 6.0.6 (the only SDK
> installed; CI pins 6.0.4 — behavior-identical, verified by the same probe
> matrix) + `emsdk activate` + `source emsdk_env.sh`, then
> `build-boost-wasm64.sh` + `build.sh`. Three Windows bring-up fixes landed
> in `build-boost-wasm64.sh` (all CI-safe on Linux):
> 1. **Toolset paths absolute**: b2's `check-tool` GLOB cannot resolve bare
>    `em++` against the MSYS-converted PATH (`provided command '"em++"' not
>    found`), even though the shell resolves it; the user-config now embeds
>    `cygpath -m $(command -v em++)` (path.exists branch, matches `.exe`
>    launchers). Linux/Mac unchanged (`command -v` is already absolute).
> 2. **`address-model=64`**: on Windows b2 defaults the clang-linux toolset
>    to `<address-model>32`, clashing with the `-sMEMORY64` object flags
>    (name-clash error, `32 vs 64`); Linux auto-detects 64 so CI never saw
>    it. MEMORY64 must match the libslic3r object build.
> 3. **`target-os=linux`**: b2 infers the TARGET os from the HOST — on a
>    Windows host that means `threadapi=win32`, `-DBOOST_THREAD_WIN32` and
>    `-DBOOST_USE_WINDOWS_H`, which cannot compile under the emscripten
>    toolset (`windows.h`/`process.h` not found, boost.atomic
>    `wait_on_address` + boost.thread win32 sources fail). wasm64 is a
>    POSIX target (emscripten pthreads), so the POSIX profile is forced
>    explicitly; Linux hosts already default to it.
> 4. **`-j${BOOST_JOBS:-4}`**: parallelize the 12-lib b2 build on fast
>    machines; defaults preserve the old CI behavior.
> Build time locally: deps fetch ~2 min, boost 12-lib wasm64 ~15 min at
> `BOOST_JOBS=16`, libslic3r ninja ~15 min on 24 cores — vs ~40 min CI.
> The `emsdk activate` requirement is why plain `source emsdk_env.sh` alone
> left `emcc` off PATH (no active SDK configured); noted here since it is
> not obvious from the script errors.

## Slice-config baseline (`orc_slice` uses the preset bundle, not bare defaults)

> **2026-08-14.** e2e-real reached the slice step for the first time
> (locateFile fix above) and failed at `validate()` with:
> *"Relative extruder addressing requires resetting the extruder position at
> each layer … Add `"G92 E0"` to layer_gcode."* Root cause: `orc_slice`
> started from `DynamicPrintConfig::full_print_config()` — bare defaults are
> **not** a validatable baseline at the pinned SHA. The default Marlin
> flavor with OrcaSlicer's default `use_relative_e_distances=1` requires
> `G92 E0` in the layer-change gcode (Print.cpp:1746), which only printer
> presets supply (`before_layer_change_gcode`). Real OrcaSlicer never slices
> on defaults: the GUI assembles the config from the selected
> print/filament/printer presets. The harness never surfaced this because
> `fixtures/config.json` sets `layer_change_gcode: "G92 E0"` explicitly.
>
> Fix (bridge.cpp `orc_slice`): the baseline is now
> `state().presets.full_config()` — `PresetBundle::full_fff_config`, the
> GUI's own mechanism (defaults → edited print preset → default filament →
> edited printer preset → project config). The client's JSON keys still
> override on top, and unrecognized-key surfacing is unchanged. This fixes
> any minimal-config client (the app sends `{}` plus user tweaks), not just
> the app; `slice_main.cpp` keeps `full_print_config()` + `config.load`
> for harness parity. Needs a WASM rebuild (CI `wasm` job) to take effect.
>
> **2026-08-14 (second round).** The full_config baseline alone was proven
> insufficient: `orc_slice({})` still failed `validate()` with the same
> error. Root cause, traced in libslic3r: with an EMPTY AppConfig (the WASM
> has no first-run wizard) **no preset is selected at all** — the vendor
> bundle loader never calls `select_preset` (the GUI's auto-select is
> commented out, Preset.cpp:1829/2044; `select_preset_by_name(name, false)`
> at the end of `load_presets` re-selects the same name = no-op). Selection
> stays on the generated "- default -" preset (Preset.cpp:1601, ctor:
> `select_preset(0)`), whose config is EMPTY, so `full_fff_config`
> (PresetBundle.cpp:4016-4020: defaults → edited print → default filament →
> edited printer → project) reduces to bare `FullPrintConfig::defaults()` —
> Marlin + `use_relative_e_distances=1` + no `G92 E0` — the exact combo the
> app hit. Every real machine preset (Afinia, re3D, Cubicon, …) is Klipper
> with `G92 E0`, so they never got a chance to apply. Fix (bridge.cpp
> `orc_init`): if the selected printer `is_default`, select the first real
> preset (`begin()` skips generated defaults) — mirroring the GUI's fallback
> in `reset_project_embedded_presets` (`select_preset(first_visible_idx())`)
> and PrusaSlicer's commented-out auto-select. `full_config()` then yields a
> real machine config and `{}` validates. Needs a WASM rebuild (CI `wasm`
> job) to take effect.
>
> **2026-08-14 (third round).** The orc_init selection alone was still
> insufficient: run-12 (built WITH the fix) failed e2e-real with the same
> validate() error. Ground-truth probe (MEMFS gcode header, one-off
> `probe-gcode.mjs`): the final config was EXACTLY bare
> `FullPrintConfig::defaults()` — `G28 ; home all axes`, `M83`, filament
> density 1.24, no printer_model — the selected printer preset contributed
> NOTHING, despite every static check (find_preset_internal, is_visible,
> canonical name, begin() range) saying select_preset_by_name should land
> on "Afinia H+1(HS) 0.4 nozzle" (klipper + `G92 E0`). Why the selection
> does not take effect is unresolved by static reading; the module cannot
> be rebuilt faster than CI, so round 3 ships BOTH:
> (1) **Deterministic invariant fix** (bridge.cpp `orc_slice`, after
> `normalize_fdm`): if the final config is Marlin flavor +
> `use_relative_e_distances=1` + no `G92 E0` in before/layer_change_gcode,
> inject the standard `";BEFORE_LAYER_CHANGE\n;[layer_z]\nG92 E0\n"` into
> `before_layer_change_gcode`. This only fires for configs that otherwise
> fail validate() outright — explicit client values that satisfy the
> invariant (klipper, rel-e=0, their own G92 E0) are untouched — so
> `orc_slice({})` slices regardless of selection state. Documented
> deviation: the pinned SHA's validate() (Print.cpp:1746) is stricter than
> the WASM's un-curated default selection can always satisfy; the bridge
> contract "a slice request must slice" wins.
> (2) **`orc_dump_state()` diagnostic** (bridge.cpp; diagnostic only, not
> part of the client API contract): selected idx/name/is_default for
> prints/filaments/printers plus the full_config() keys gcode_flavor,
> use_relative_e_distances, before/layer_change_gcode, bed_shape,
> printer_model, machine_start_gcode, filament_density — turning the
> selection-mystery into data for the next iteration. Uses `optptr`/`size`
> guards throughout so a diagnostic can never crash the module.
>
> **2026-08-14 (fourth round).** The dump delivered, and the mystery
> initially resolved to a build-specific divergence. `orc_dump_state` on
> the run-13 module: selection still on the generated default (`idx 0,
> "Default Printer", is_default true`) — so round 2's
> `select_preset_by_name` executed and the find MISSED at runtime, falling
> back to idx 0. Yet EVERY link of that call is source-correct at the
> pinned SHA, re-verified one by one: `begin()` skips defaults
> (Preset.hpp:510) and yields "Afinia H+1(HS) 0.4 nozzle" (probe-verified);
> `sort_presets()` runs in both loader paths (Preset.cpp:1826/2042) with
> `operator<` = plain name order; the names round-trip bare through
> parse/canonical (kind User → bare, no prefix); `find_preset_internal`'s
> `lower_bound_by_predicate` (libslic3r.h:233) is a textbook binary
> search; Afinia is visible (`instantiation` ≠ "false", Preset.cpp:1723).
> Source says found; binary says miss. Working hypothesis:
> `lower_bound_by_predicate`'s `std::distance`/`std::advance` over the
> `std::deque` misbehave under wasm64 MEMORY64 — plain increment
> iteration is the one operation proven correct in this binary (the
> sorted preset list prints fine). Round 4 therefore replaces the
> selection with a LINEAR SCAN with a hand-counted index
> (`lbegin()..end()` by `++`, skip `is_default`, select first visible via
> `select_preset`), i.e. the GUI's `reset_project_embedded_presets`
> mechanism minus the Orca-only `ORCA_FILAMENT_LIBRARY` vendor filter
> (first_visible_idx's filter would exclude every vendor printer and fall
> back to the default again — verified Preset.cpp:3312). `orc_dump_state`
> gains the scan's inputs (`leading_defaults`, sizes). The G92 E0
> invariant stays as defense-in-depth.
>
> **2026-08-14 (fifth round) — the wasm64 hypothesis RETRACTED.** Run 15
> (a6bb890, e2e-real green) probed: selection STILL on the default (`idx
> 0`, `full_config` = bare defaults — `gcode_flavor marlin`, default
> `G28 ; home all axes` start gcode, not Afinia's klipper `PRINT_START`),
> and the same module read `scan.printers_size` as **1 in one probe and
> 1010 in another** — which looked like garbage deque arithmetic. It was a
> probe bug: the size-1 probe (probe-dump.mjs) never called `orc_init`,
> so its "after init" dump ran against the un-loaded collection (1 =
> default-only, correct). With `orc_init` called first, `size()` reads a
> stable 1010 across 8 consecutive dumps, before and after heap churn —
> `size()` is NOT broken. Likewise `begin()+m_num_default_presets`
> (iterator addition) works (`orc_get_presets` lists 1009 real presets
> through it), field reads work (leading_defaults loop stops at Afinia:
> `is_default` false), and — decisively — `load_selections`
> (PresetBundle.cpp, called at the END of `PresetBundle::load_presets`)
> selected a REAL filament by name: `filaments idx 528 "Generic PLA
> @System"`. **find-by-name + `select_preset` demonstrably work in this
> binary** (round 2's "miss" was actually `begin()->name` = the DEFAULT's
> name — round 2 selected the default by design and misread the outcome).
> What was never observed directly: `it->is_visible` for a real preset
> (the round-4 dump only read `is_default`). If that read returns false
> in the binary, the scan's `!it->is_visible` gate skips all 1009 presets
> — matching every observation. Round 5: the scan drops the visibility
> gate (a headless baseline needs A machine profile; hidden
> `instantiation:"false"` printers are an M4 GUI concern), the dump gains
> `num_visible` + `would_pick` (the scan decision with `is_visible`
> observed), and a new `orc_select_printer(idx)` calls `select_preset`
> directly so its effect is isolated from the scan's gates.
>
> **2026-08-14 (sixth round) — the mechanism, source-confirmed and
> verified.** The round-5 dump and probe (run 16 artifact, locally) close
> the case:
> - `is_visible` DOES read false for real presets — but not via the
>   `instantiation` loader: with an empty AppConfig, `load_selections`
>   (PresetBundle.cpp:2775, at the end of `load_presets`) calls
>   `load_installed_printers`, which calls
>   `Preset::set_visible_from_appconfig` (Preset.cpp:855) per preset;
>   for TYPE_PRINTER it assigns `is_visible = app_config.get_variant(
>   vendor->id, model, variant)` — **false for every system printer when
>   nothing is installed**. That is the gate round 4's scan tripped on,
>   the complete mechanism (no wasm64 binary magic anywhere).
> - Filaments selected at 528 because the filament branch of
>   `set_visible_from_appconfig` is skipped entirely when the AppConfig
>   has no `filaments` section → `is_visible` stays true → the binary
>   search found "Generic PLA @System".
> - Probe (run 16, round-5 code): `printers idx=1 "Afinia H+1(HS) 0.4
>   nozzle"` at init; `full_config` = klipper + `PRINT_START EXTRUDER=...
>   BED=...`; `select_printer(0/1/1009)` all stick; sliced + exported
>   G-code's start block follows the selection exactly (default →
>   Marlin `G28 ; home all axes`; Afinia → `;M190 S35 ;M109 S220
>   PRINT_START EXTRUDER=220 BED=35`; TerabotX idx 1009 → its own
>   `M220/M221/G28/G92 E0/G1 Z0.3`). Placeholders resolve; `num_visible`
>   reads 1 after the scan (only the scan-selected preset visible — the
>   `set_visible_from_appconfig` signature, since `select_preset` forces
>   its target visible). Slice validates and exports for every selection.
>   **M3 selection fidelity: done.** M4 carry-forward: the preset-picker
>   UI must drive installed-state via the real AppConfig/variant
>   mechanism (not `is_visible` directly), and `instantiation:"false"`
>   profiles become an installed/available concern.
- Manual GUI pass on a packaged installer (`package:win` → install → run).
