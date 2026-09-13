# M4 — Preset Management with AppConfig Fidelity (implementation notes)

Date: 2026-08-15. Status: **historical and superseded**. Design:
`doc/2026-08-15-m4-preset-management-design.md` (historical). Milestone:
`spec/Grand Plan.md` → "Full settings surface + search
(from metadata); preset management".

> The APIs and schemas recorded below were removed before release. They are
> retained only as historical provenance; current code has no AppConfig bridge,
> single-filament selector, compatibility tail, or migration path. Follow the
> approved architecture and multi-filament specs instead.

## Delivered

- **Bridge** (`packages/slicer-wasm/src/bridge.cpp`): `orc_init(app_config_json)`
  (nullable; no-arg = exactly the old behavior), `orc_set_app_config(json)`,
  `orc_get_app_config()`, `orc_select_preset(kind, name)` (real selection path
  with the `load_selections` compat tail + all-three write-back),
  `orc_get_presets(kind)` enriched with `is_visible` / `is_default` /
  `selected` / `vendor_id` / `model` / `variant`. `orc_dump_state` extended
  with the selected printer's vendor/model/variant.
- **Client** (`packages/slicer-wasm/src/client/`): `init(appConfig?)`,
  `setAppConfig`, `getAppConfig`, `selectPreset`, `PresetInfo.selected`,
  `AppConfig`, `SelectPresetResult`; mock module mirrors all new ops.
- **Electron app** (`apps/desktop/`): IPC `appConfig:load` / `appConfig:save`
  (main reads/writes `userData/appconfig.json`), boot wiring (`App.tsx` loads
  config → `init(json)` → enriched presets), picker groups visible presets
  first with a dimmed "Not installed" group, selection change → `selectPreset`
  → store sync → `appConfig.save`.
- **Verification**: probe-m4.mjs (9 sections), client vitest (+4 M4 tests),
  stores vitest (+2), CSP headers (prod + dev).

## Deviations from the design

1. **`selected` flag added to `orc_get_presets` entries.** The design lists
   `is_visible`/`is_default`/`vendor_id`/`model`/`variant`; the store needs a
   selection signal per entry and the design's three separate lists would
   otherwise have to be cross-referenced. `selected: bool` on every entry is
   the ground truth (compare against `coll.get_selected_preset_name()`);
   `useSettingsStore.setPresets` derives the three selection strings from it.

2. **Afinia exact name.** The design's verification example uses
   `presets.printer: "Afinia H+1(HS)"` — the selectable preset is
   **"Afinia H+1(HS) 0.4 nozzle"** (profiles/Afinia/machine/). Selection is
   by exact name; the probe uses the nozzle-qualified string.

3. **wasm64 no-arg calling convention.** `orc_init` gained a C parameter;
   in the wasm64 wrapper **every C param must receive a JS value** — calling
   with no args passes `undefined` and the wrapper throws
   `TypeError: Cannot convert undefined to a BigInt` (CppException-adjacent
   class of defect, but a JS-side one). The client's no-arg `init()` and the
   harness pass `['string'], ['']` — an empty string means "no config".

4. **MSYS `;` conversion skip (build fix).** `-DPRELOAD_FILES="A@/system;B@/info"`
   contains `;`, and MSYS skips path conversion for args containing it —
   so file_packager (a native Windows exe) received `/f/MyProject/...`
   instead of `F:/MyProject/...` and failed to resolve the tree. `build.sh`
   now converts both dirs with `cygpath -m` (guarded by `command -v cygpath`;
   no-op on Linux CI).

5. **`-fexceptions` on the bridge TUs — the real catch(...) fix.** All bridge
   ops carry a `catch (const std::exception&)` + `catch (...)` fallback, but
   on the first full verification run the probe's section 4 still crashed
   with an uncatchable `CppException` at the exact statement
   `unescape_strings_cstyle(j_model["nozzle_diameter"], variants)` (a
   nlohmann array→string `type_error`) — the `orc_init` catch markers never
   printed. Root cause (proved by `ninja -t commands` on the two TUs):
   `-fexceptions` lived only in `target_link_options` (link-time), and the
   `orca_slice` executable had no `target_compile_options` — emcc's default
   `-fignore-exceptions` **compiles `try`/`catch` out**, so the handlers were
   dead code while `-sDISABLE_EXCEPTION_CATCHING=0` kept the runtime unwind
   alive. Fix: `target_compile_options(orca_slice PRIVATE -fexceptions)`
   (CMakeLists.txt). The libslic3r/deps TUs already had it from their own
   targets, which is why the exception runtime "worked" while the bridge
   catches never fired. A second session finding in the same probe: the
   first hardened rebuild failed to compile — a mechanical replace-all had
   inserted a duplicate `catch (...)` at `orc_slice` (a pre-existing
   Fix-round-1 handler sat there) → "catch-all handler must come last"; the
   error line was lost to truncated background-task capture, and
   re-running the exact compile command from build.ninja surfaced it. The
   duplicate was removed; the pre-existing handler (rethrow + std::string/
   const char* extraction) was kept — it is strictly stronger.

6. **CSP headers (carry-forward item).** Electron's "Insecure
   Content-Security-Policy" devtools warning came from having **no** CSP:
   prod adds one in `startRendererServer` (`main/index.ts`, strict —
   no inline scripts in the built bundle) and dev adds a looser one in
   `electron.vite.config.ts` (`'unsafe-inline'` in script-src for
   `@vitejs/plugin-react`'s react-refresh preamble). Both allow
   `'wasm-unsafe-eval'` (the Emscripten module instantiates inside the
   same-origin module worker, which inherits the document CSP) and
   `worker-src 'self'` (the slicer worker is `new Worker(new URL(...),
   {type:'module'})` — same-origin, no blob: needed).

7. **`AppConfigLoadResult` shape.** IPC `appConfig:load` returns
   `{found, json}` — `found: false` when the file is missing or unparsable
   (boot then calls `init()` with no payload, the fresh-config default). The
   design didn't pin this shape.

8. **AppConfig persistence is opt-in in e2e.** Main's `appConfigPersisted()`
   gates load/save: normally always on (userData); under `ORCA_E2E=1` only
   when `ORCA_E2E_APPCONFIG` names a path (e2e supplies its own file so tests
   never touch the developer's real config).

## Session findings (root-cause log)

- **Section-4 `CppException { excPtr }` — root cause: `-fignore-exceptions`
  compiled the bridge's catches out.** Markers pinned the crash to
  `unescape_strings_cstyle(j_model["nozzle_diameter"], variants)` in
  `apply_app_config`: the probe's array-form `nozzle_diameter` hits
  nlohmann's implicit array→string conversion, which throws `type_error`
  (302). The throw unwound into JS (link-time `-sDISABLE_EXCEPTION_CATCHING=0`
  keeps the runtime active) and surfaced as `CppException { excPtr }` because
  bridge.cpp's `catch` handlers were dead code — the TU compiled without
  `-fexceptions` (deviation 5). Two complementary fixes:
  1. `-fexceptions` on the bridge TUs (root cause) — the throw is now caught,
     `orc_init` returns `{"error": ...}` and the module stays alive.
  2. Lenient `nozzle_diameter` parsing in `apply_app_config`: the fork's
     on-disk form is an **escaped string** (`"[\"0.4\"]"`, what
     `serialize_app_config` emits); accept a plain array too (probe fixtures,
     hand-written configs). Self-consistent: whatever `orc_get_app_config`
     emits round-trips through `orc_init`.
- **Fresh-install "filaments" regression — root cause: REPLACE semantics.**
  After `reset_app_config` (config JSON is authoritative, never merged), the
  fresh path's `load_presets` ran before any variant existed, so
  `load_installed_filaments` (called inside the public `load_selections`)
  saw zero visible printers and recorded nothing — the persisted config's
  `filaments` section stayed empty (pre-clear, 865 entries were leaking in
  from a stale vendors map across inits, which the reset rightly removed).
  Fix: `install_all_printers` now ends with `state().presets.load_selections(cfg)`
  — the public entry that runs the (private) `load_installed_filaments`
  mechanism — restoring 865 default filaments via the real path.
- **The rebuild failure was NOT a toolchain problem.** The failed run's mass
  recompile + truncated error capture looked like an emsdk/PATH drift; the
  actual error was my own duplicate `catch (...)` (deviation 5). Single-TU
  verification via `ninja -t commands <target>` + running the printed
  command directly is the fast loop — no full rebuild to diagnose a compile
  error. (Second failure, same class: the private
  `load_installed_filaments` call — access is under `private:` in
  PresetBundle.hpp — fixed by routing through public `load_selections`.)

## Verification results

- vitest: slicer-wasm 19/19 (incl. 4 M4 client tests), desktop 6/6 (incl.
  store preset tests). Typecheck clean both projects.
- probe-m4.mjs against the final module: **all 9 sections PASS** — fresh
  all-installed (1009/1009 visible, first-non-default selected), machine
  selection, real select + all-three config round-trip (print/filament
  follow compatibly: `0.30mm Strength @Afinia H+1(HS) 0.6 nozzle` +
  `Generic PLA @System`), partial install (exactly the listed variant
  visible; config round-trips `nozzle_diameter:"0.4"` in the fork's escaped
  form), `orc_set_app_config` re-init, enriched entry shape (printers +
  filaments), no-arg backward compat, slice + no nozzle_info warning, and
  the carry-forward: bad `gcode_flavor` → `{"error":...}` with the module
  alive (the catch-all now genuinely runs).
- `bridge-smoke.mjs`: 20/20 PASS (slice, progress, result buffers, mesh,
  offset, export, cancel, removeFunction reload, unknown-key reporting).
- `run-slice.mjs`: exit 0, 297 KB / 13234-line G-code, spot-checks green.

## Files touched

- `packages/slicer-wasm/src/bridge.cpp` — M4 ops + catch-all hardening,
  lenient `nozzle_diameter` parsing, fresh-install filaments via
  `load_selections`
- `packages/slicer-wasm/CMakeLists.txt` — PRELOAD_FILES list → per-file
  `--preload-file` link options; `target_compile_options(orca_slice PRIVATE
  -fexceptions)` (the bridge TUs' catches were compiled out before)
- `packages/slicer-wasm/build.sh` — cygpath -m for PRELOAD_FILES/INFO_DIR
- `packages/slicer-wasm/src/client/{client,types,index}.ts` + `testing/
  mock-module.ts` + `client.test.ts`
- `packages/slicer-wasm/harness/bridge-smoke.mjs` — wasm64 no-arg init
- `apps/desktop/src/shared/ipc.ts`, `main/index.ts` (appConfig IPC + CSP),
  `preload/index.ts`, `renderer/src/env.d.ts`, `renderer/src/App.tsx`,
  `renderer/src/stores/useSettingsStore.ts` (+ test),
  `renderer/src/components/workspace/settings/SettingsPanel.tsx`,
  `electron.vite.config.ts` (dev CSP)

Submodule `packages/slicer-wasm/cpp` untouched (patches applied at build
time only); no new patches needed for M4.
