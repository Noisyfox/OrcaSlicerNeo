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
  Emscripten loads `.wasm`/`.data` relative to the module script — same
  dir, no `locateFile` override.
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
  `--linux` (x64+arm64 AppImage), macos-13 → `--mac --x64`, macos-14 →
  `--mac --arm64`. All six bundle the same staged artifact; installers
  uploaded (retention 14 d), unsigned. The windows job emits THREE
  artifacts: electron-builder 26.15.3 eagerly cross-builds x64 + arm64 plus
  a combined multi-arch `-win.exe`; the upload glob `release/*.exe` covers
  all three.
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
- Manual GUI pass on a packaged installer (`package:win` → install → run).
