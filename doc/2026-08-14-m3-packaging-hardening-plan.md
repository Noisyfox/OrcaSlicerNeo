# M3 Packaging & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the M2 vertical slice as installable, CI-verified desktop apps: electron-builder packaging for all six targets, Playwright Electron e2e, a GitHub Actions matrix, the full preset bundle, AGPL licensing, and a slice cross-check procedure.

**Architecture:** One Emscripten WASM build is produced once in CI and staged into the renderer (`public/wasm/` → `out/renderer/wasm/`) for every app build. electron-builder packages `out/` with the wasm assets asar-unpacked (binary fetch from the packaged `file://` context). e2e runs the built app two ways: mock module (no emsdk needed, runnable on any machine) and real module (CI, after the WASM build). The CI WASM job is the first real execution of the M2-deferred bridge verification.

**Tech Stack:** electron-builder (NSIS/AppImage/DMG), Playwright `@playwright/test` (`_electron`), GitHub Actions, Emscripten 6.0.4 (per the design doc's risk table — the spike's validated version), existing stack unchanged.

**Spec:** [`doc/2026-08-12-electron-gui-rewrite-design.md`](../doc/2026-08-12-electron-gui-rewrite-design.md) (Packaging §, Testing & Verification §, Phases F), milestone checklist [`spec/Grand Plan.md`](../spec/Grand Plan.md) M3, roadmap [`doc/high_level_dev_plan.md`](../doc/high_level_dev_plan.md) Epic 3.x. The design is the binding authority; this plan argues from it.

## Global Constraints

Copied verbatim from the design doc / AGENTS.md / CLAUDE.md / Grand Plan / high-level dev plan. **Every task's requirements implicitly include this section.**

1. **Six targets, one module**: electron-builder for win x64/arm64 (NSIS), linux x64/arm64 (AppImage), mac x64/arm64 (DMG) — all six bundles ship the same `.wasm` + `.data`. Unsigned v1 (macOS signing deferred).
2. **CI matrix**: GitHub Actions builds WASM + app, runs smoke/unit/e2e.
3. **Full preset bundle**: full `resources/profiles` via `--preload-file` replaces the curated subset (`PresetBundle::load_presets` reads `<data_dir>/system/*.json`; mount stays `/system`).
4. **Bridge is the only seam**: renderer code never imports the WASM module directly; only `slicer.worker.ts` touches module/mock. The mock is tree-shaken out of non-mock builds (`VITE_USE_MOCK` is compile-time via `import.meta.env`).
5. **Submodule is read-only**: `packages/slicer-wasm/cpp/` pinned to `b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde`; changes only via `patches/*.patch`, never ad-hoc edits.
6. **WASM build is iterative**: `TBB_HEADERS` / `DROP_PATTERNS` / `stubs/` / bridge-API drift are the documented fix loops (AGENTS.md). The CI WASM job will hit them on first run — fix in this repo, re-run CI.
7. **Dep pins**: do not bump existing dependencies (electron ^34, three 0.160.x, fiber ^8.15, zustand ^4, vitest ^2.1, tailwind ^3.4, radix ^1.1). New devDeps only: `@playwright/test` (^1.49 or newer — must support Electron 34). Runtime pinned via Volta (node 22.14.0, pnpm 10.0.0).
8. **AGPL-3.0 throughout**: root `LICENSE` (AGPL-3.0) + source-offer notes; installer shows the license.
9. **e2e asserts gcode file contents** (design: "launch the packaged/dev app, drive the full v1 flow, assert gcode file contents").
10. **wasm64 consistency**: objects, Boost archives, link flags all `-sMEMORY64`; no pthreads in v1. `INITIAL_MEMORY=64MB` + `ALLOW_MEMORY_GROWTH` already set — the 72 MB profile bundle grows the heap at startup (accepted; note in docs).
11. **Docs-first**: dated notes in `doc/`; this plan + `doc/2026-08-14-m3-implementation-notes.md`; keep `spec/Grand Plan.md` and `doc/high_level_dev_plan.md` in sync with delivered work.
12. **Naming**: `orca_*` bridge fns, `orca_slice` module, `src/client/`, `slicer/` worker dir, `components/`. Never write the phase-0 spike's project name into any file.
13. **Commits on `main` directly** (M0/M1/M2 precedent, user-approved).
14. **The packaged-app wasm URL**: `/wasm/orca_slice.js` (absolute) works in dev only; the packaged app loads the renderer via `file://` where absolute paths resolve to the filesystem root — M3 fixes this (Task 2).

## File Structure

Files created/modified by this milestone:

| Path | Task | Responsibility |
|---|---|---|
| `apps/desktop/electron-builder.yml` | T1 | electron-builder config: 6 targets, asarUnpack wasm, artifact names |
| `apps/desktop/package.json` | T1/T3/T6 | scripts (`package:win`, `package:dir`, `test:e2e`, `test:e2e:real`), author, license |
| `apps/desktop/.env.e2e` | T3 | `VITE_USE_MOCK=1` for the `--mode e2e` build |
| `apps/desktop/playwright.config.ts` | T3 | Playwright config (testDir `e2e/`, workers 1) |
| `apps/desktop/e2e/app.e2e.ts` | T3 | Full v1 flow spec (mock locally / real in CI) |
| `apps/desktop/e2e/packaged.e2e.ts` | T3 | Packaged-app probe (real URL path, stub module) |
| `apps/desktop/e2e/stub/orca_slice.js` | T3 | Plain-JS stub Emscripten module for the packaged probe (gitignored staging) |
| `scripts/stage-stub-wasm.mjs` | T3 | Copies the stub into `public/wasm/` (temp, for the packaged probe) |
| `apps/desktop/src/main/index.ts` | T3 | `ORCA_E2E` env-gated dialog stub (Playwright cannot drive native dialogs) |
| `apps/desktop/src/renderer/src/components/**` | T3 | `data-testid` attributes (Toolbar, StatusBar, SettingsPanel, Viewport, LayerScrubber) |
| `apps/desktop/tsconfig.node.json` | T3 | include `e2e/**/*` + `playwright.config.ts` |
| `apps/desktop/src/renderer/src/slicer/slicer.worker.ts` | T2 | wasm URL: `PROD ? '../wasm/orca_slice.js' : '/wasm/orca_slice.js'` |
| `scripts/stage-wasm.mjs` | T4 | also copies `orca_slice.data` |
| `packages/slicer-wasm/build.sh` | T4 | curated embed → full `--preload-file` (`WASM_PROFILES_DIR` override); copy `.data` |
| `packages/slicer-wasm/CMakeLists.txt` | T4 | `EMBED_FILE` → `PRELOAD_FILE` link option |
| `.github/workflows/ci.yml` | T5 | wasm / unit / e2e-mock / e2e-real / package matrix |
| `LICENSE` (root) | T6 | AGPL-3.0 full text |
| `SOURCE_OFFER.md` (root) | T6 | Corresponding-source offer (repo URL, commit, build pointer) |
| `scripts/crosscheck-slice.mjs` | T7 | Compare WASM-module gcode vs desktop OrcaSlicer gcode |
| `spec/Grand Plan.md`, `doc/high_level_dev_plan.md` | T8 | M3 checkboxes + status |
| `doc/2026-08-14-m3-implementation-notes.md` | T8 | M3 record: decisions, contracts, verify steps, deferrals |

**Interfaces between tasks:**

- T2 consumes the worker URL mechanics (verified in dev by M2); T3's `packaged.e2e.ts` consumes T2's fixed URL.
- T3's mock e2e is independent of T2 (mock path never touches the wasm URL).
- T4 consumes `WASM_PROFILES_DIR` (default full tree); T5's CI wasm job consumes T4's `.data` artifact (stage-wasm must find `orca_slice.data`).
- T5 package job consumes T1's `electron-builder.yml` + `package` script; T6 adds the `nsis.license` line to T1's config.
- T7 is standalone (pure script + doc).
- T8 consumes all of the above for the status docs.

---

## Task 1: electron-builder config + Windows x64 build

**Files:**
- Create: `apps/desktop/electron-builder.yml`
- Modify: `apps/desktop/package.json` (scripts, author)

**Interfaces:**
- Produces: `pnpm --filter desktop package:win` → `apps/desktop/release/OrcaSlicerNeo-<ver>-win-x64.exe` (unsigned NSIS). T5's package job reuses the config for the remaining five targets. T6 adds `nsis.license` to this file.

- [ ] **Step 1: Create `apps/desktop/electron-builder.yml`**

```yaml
# apps/desktop/electron-builder.yml — M3 packaging (design §Packaging).
# All six targets ship the same WASM module: stage:wasm runs before packaging
# (CI: artifact download → scripts/stage-wasm.mjs). Unsigned v1 (macOS signing
# deferred). Config is cross-validated in CI; only Windows x64 is buildable on
# the dev machine (NSIS), the other five targets build on the CI matrix.
appId: com.orcaslicerne.neo
productName: OrcaSlicerNeo
directories:
  output: release
files:
  - out/**
  - "!out/**/*.map"
# Binary assets (wasm + preloaded data) load via fetch() in the renderer's
# file:// context — fetch() cannot read inside asar, so unpack them.
asarUnpack:
  - out/renderer/wasm/**
win:
  target:
    - target: nsis
      arch: [x64, arm64]
  artifactName: OrcaSlicerNeo-${version}-${os}-${arch}.${ext}
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  shortcutName: OrcaSlicerNeo
linux:
  target:
    - target: AppImage
      arch: [x64, arm64]
  category: Utility
  artifactName: OrcaSlicerNeo-${version}-${os}-${arch}.${ext}
mac:
  target:
    - target: dmg
      arch: [x64, arm64]
  category: public.app-category.graphics-design
  identity: null # unsigned v1 (design: "macOS signing deferred")
  artifactName: OrcaSlicerNeo-${version}-${os}-${arch}.${ext}
npmRebuild: false # no native node deps; everything is bundled by Vite
publish: null
```

- [ ] **Step 2: Add `author` and packaging scripts to `apps/desktop/package.json`**

Add `"author": "OrcaSlicerNeo contributors"` after `"description"` (electron-builder warns without it), and to `"scripts"`:

```json
"package:win": "electron-vite build && electron-builder --win --x64 --publish never",
"package:dir": "electron-vite build && electron-builder --dir --publish never",
"package": "electron-vite build && electron-builder --publish never"
```

(`package` is the CI entry point — the matrix appends `--win` / `--linux` / `--mac` args after `pnpm --filter desktop package --`.)

- [ ] **Step 3: Install electron-builder**

Run: `pnpm --filter desktop add -D electron-builder`

Expected: `electron-builder` added to `apps/desktop/package.json` devDependencies (electron-builder pulls no runtime deps; it is a build-time tool).

- [ ] **Step 4: Verify the Windows x64 build**

Run: `pnpm --filter desktop package:win`

Expected: exits 0 and prints `building... target=nsis arch=x64 file=release\OrcaSlicerNeo-<ver>-win-x64.exe`. The NSIS installer is unsigned (fine — design: unsigned v1). First run downloads the NSIS tooling + the Electron 34 win32-x64 dist (~100 MB, network required).

Notes if the build fails (iterate, don't guess):
- `appId` invalid → change it; `files` pattern wrong → adjust; missing `author` → add.
- If electron-builder refuses `arch: [x64, arm64]` on this machine for NSIS, that is expected on some versions — keep the config (CI builds arm64 on windows-latest) and verify with `--win --x64` only. Record the outcome in the report.

- [ ] **Step 5: Sanity-check the produced app**

Run: `ls apps/desktop/release/` and confirm `OrcaSlicerNeo-<ver>-win-x64.exe` exists. Do NOT run the installer (Task 3's packaged probe covers runtime correctness in an unpacked build). Confirm `apps/desktop/release/` is gitignored — add `apps/desktop/release/` to the root `.gitignore` if it is not already ignored (it is not in the current `.gitignore`; add the line).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron-builder.yml apps/desktop/package.json apps/desktop/pnpm-lock.yaml .gitignore
git commit -m "build(m3): electron-builder config for six targets; win x64 NSIS verified"
```

---

## Task 2: Fix the WASM URL for the packaged app

**Files:**
- Modify: `apps/desktop/src/renderer/src/slicer/slicer.worker.ts:16`

**Interfaces:**
- Consumes: `out/renderer/` layout — `index.html` + `wasm/` at the renderer root, worker chunk emitted to `out/renderer/assets/slicer.worker-[hash].js` (Vite default `assetsDir`).
- Produces: packaged-app worker resolves the module at `<renderer-root>/wasm/orca_slice.js`. T3's `packaged.e2e.ts` verifies this end to end.

**Why:** Dev serves the renderer `public/` dir at `/`, so `'/wasm/orca_slice.js'` works. The packaged app loads the renderer via `loadFile()` → `file://…/out/renderer/index.html`; an absolute `/wasm/…` dynamic import resolves against the filesystem root and fails. A **relative** specifier in a dynamic `import()` resolves against the importing module's URL — the worker chunk in `assets/`, so `'../wasm/orca_slice.js'` lands exactly at `out/renderer/wasm/orca_slice.js`. `import.meta.env.PROD` is inlined at build time by Vite, so dev keeps `/wasm/…` and prod gets the relative path. No `new URL()` literals (Vite would try to asset-resolve them and fail since the file is absent at build time on this machine).

- [ ] **Step 1: Edit the worker factory**

In `apps/desktop/src/renderer/src/slicer/slicer.worker.ts`, replace the `wasmUrl` line (currently line 16):

```ts
      // dev: Vite serves the renderer public/ dir at '/' — the staged module
      // lives at public/wasm/orca_slice.js. prod: the page is file://…/index.html
      // and absolute paths hit the filesystem root; the worker chunk sits in
      // out/renderer/assets/, so the relative specifier '../wasm/orca_slice.js'
      // resolves against the chunk URL → out/renderer/wasm/orca_slice.js.
      // (Emscripten loads orca_slice.wasm/.data relative to the module script,
      // which is that same dir — no locateFile override needed.)
      const wasmUrl = import.meta.env.PROD
        ? '../wasm/orca_slice.js'
        : '/wasm/orca_slice.js';
```

- [ ] **Step 2: Verify the production build emits the expected layout**

Run: `pnpm --filter desktop build`

Expected: exit 0. Then confirm layout with:
`ls apps/desktop/out/renderer/` → contains `index.html` and `assets/`; `ls apps/desktop/out/renderer/assets/` → contains `slicer.worker-*.js` (and `slicer.worker-*.js`'s first line is `"use strict"` + `import` statements, i.e. a real module worker chunk). The chunk must NOT contain the string `VITE_USE_MOCK` or `createMockModule` (mock tree-shaken from prod builds — same property M2's final review verified).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/slicer/slicer.worker.ts
git commit -m "fix(m3): relative wasm URL in prod worker chunks (packaged file:// apps)"
```

---

## Task 3: Playwright Electron e2e (mock + packaged probe)

**Files:**
- Create: `apps/desktop/playwright.config.ts`, `apps/desktop/e2e/app.e2e.ts`, `apps/desktop/e2e/packaged.e2e.ts`, `apps/desktop/e2e/stub/orca_slice.js`, `apps/desktop/.env.e2e`, `scripts/stage-stub-wasm.mjs`
- Modify: `apps/desktop/src/main/index.ts` (dialog stub), `apps/desktop/package.json` (devDep + scripts), `apps/desktop/tsconfig.node.json` (include e2e)

**Interfaces:**
- Consumes: T2's worker URL fix (packaged probe); the mock module (`@slicer/testing`) with its exact fixture values; the M2 IPC surface (`window.orca.openFileDialog/saveFileDialog/readFile/writeFile`); `Toolbar`/`StatusBar`/`SettingsPanel`/`Viewport`/`LayerScrubber` components.
- Produces: `pnpm --filter desktop test:e2e` (runs everywhere, mock mode) and `test:e2e:real` (CI, real wasm). `ORCA_E2E` env contract for the main-process dialog stub (used by both specs and CI).

**Exact fixture values (from the mock, do not invent):**
- Mock presets: printer `'Bambu Lab X1 Carbon 0.4 nozzle'`; status text mapping: `done → 'Sliced'`, `idle → 'Ready'`, `slicing → 'Slicing…'`; mock gcode content: `; mock gcode (unit-test fixture)`; mock slice fixture: 40 layers; model: `packages/slicer-wasm/fixtures/cube.stl` (exists — the root `smoke` script uses it).

**Design decisions:**
- `VITE_USE_MOCK` is compile-time (`import.meta.env`), so e2e builds the app first: `electron-vite build --mode e2e` loads `.env.e2e` (`VITE_USE_MOCK=1`) — no `cross-env` dependency. Real mode is the plain `electron-vite build` (no mode file) → real wasm path; the spec picks expectations from an env flag passed through the Playwright process.
- Native dialogs cannot be driven by Playwright → `ORCA_E2E=1` in the main process replaces `openFileDialog`/`saveFileDialog` with fixed paths from env (`ORCA_E2E_MODEL` / `ORCA_E2E_EXPORT`). WriteFile is untouched — the export assert reads the real file from disk.
- Local verification of the packaged-app URL path (T2) needs a WASM-shaped module without emsdk: a committed plain-JS stub (`e2e/stub/orca_slice.js`) is staged into `public/wasm/` by `scripts/stage-stub-wasm.mjs`, then the app is packaged `--dir` and probed. `public/wasm/` is gitignored, so the stub never enters git; CI replaces it with the real artifact.

- [ ] **Step 1: Install Playwright**

Run: `pnpm --filter desktop add -D @playwright/test`

Expected: `@playwright/test` (^1.49 or newer) in devDependencies. No browser download is needed — Playwright drives the app's own Electron binary.

- [ ] **Step 2: Main-process dialog stub — edit `apps/desktop/src/main/index.ts`**

Add after `const { Ipc, type FileDialogFilter } = require…`-equivalent import line (line 4):

```ts
// e2e hook: Playwright cannot drive native dialogs, so with ORCA_E2E=1 the
// open/save handlers return fixed paths from the environment. Only ever set
// by the e2e launcher (playwright config / CI); never in production.
const e2eOpenPath = process.env.ORCA_E2E === '1' ? (process.env.ORCA_E2E_MODEL ?? null) : null;
const e2eSavePath = process.env.ORCA_E2E === '1' ? (process.env.ORCA_E2E_EXPORT ?? null) : null;
```

Then modify the two handlers (keep the existing bodies as the non-e2e path):

```ts
  ipcMain.handle(Ipc.openFileDialog, async (event, filters: FileDialogFilter[]) => {
    if (e2eOpenPath !== null) return { canceled: false, path: e2eOpenPath };
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters,
    });
    return { canceled, path: canceled ? null : (filePaths[0] ?? null) };
  });

  ipcMain.handle(Ipc.saveFileDialog, async (event, defaultName: string, filters: FileDialogFilter[]) => {
    if (e2eSavePath !== null) return { canceled: false, path: e2eSavePath };
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      defaultPath: defaultName,
      filters,
    });
    return { canceled, path: canceled ? null : (filePath ?? null) };
  });
```

- [ ] **Step 3: Test ids — edit the renderer components**

Add `data-testid` attributes (implementation detail left to the implementer; the exact ids are the contract):

| File | Element | testid |
|---|---|---|
| `components/layout/Toolbar.tsx` | Open button | `btn-open` |
| `components/layout/Toolbar.tsx` | Slice button | `btn-slice` |
| `components/layout/Toolbar.tsx` | Export button | `btn-export` |
| `components/layout/StatusBar.tsx` | status text `<span>` | `slicer-status` |
| `components/workspace/settings/SettingsPanel.tsx` | printer preset `Select` trigger | `preset-select` |
| `components/workspace/viewport/Viewport.tsx` | canvas wrapper `<div>` | `viewport` |
| `components/workspace/viewport/LayerScrubber.tsx` | slider root | `layer-scrubber` |

The status `<span>` in StatusBar is the element whose `textContent` the spec asserts (`Ready` / `Sliced`).

- [ ] **Step 4: `.env.e2e`**

Create `apps/desktop/.env.e2e`:

```
VITE_USE_MOCK=1
```

- [ ] **Step 5: package.json scripts**

Add to `apps/desktop/package.json` `"scripts"`:

```json
"test:e2e": "electron-vite build --mode e2e && playwright test",
"test:e2e:real": "electron-vite build && playwright test"
```

(`test:e2e:real` expects the real module staged (`node scripts/stage-wasm.mjs`) and requires `ORCA_E2E_REAL=1` in the environment to assert real gcode — set by CI. On PowerShell locally: `$env:ORCA_E2E_REAL='1'; pnpm --filter desktop test:e2e:real`.)

- [ ] **Step 6: `playwright.config.ts`**

Create `apps/desktop/playwright.config.ts`:

```ts
// apps/desktop/playwright.config.ts — Playwright Electron e2e (M3).
// Run modes:
//   pnpm test:e2e          build (VITE_USE_MOCK=1) + run — mock module, no emsdk
//   pnpm test:e2e:real     build (real module, stage:wasm first) + run with
//                          ORCA_E2E_REAL=1 — real wasm, CI job e2e-real
// Electron is driven via @playwright/test's _electron.launch — no browser
// download needed. One app at a time (workers: 1) — Electron is heavyweight
// and the specs share an export temp dir per launch.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
});
```

- [ ] **Step 7: The full-flow spec — create `apps/desktop/e2e/app.e2e.ts`**

```ts
// apps/desktop/e2e/app.e2e.ts — the full v1 flow against the built app.
// Mock mode (default): expects the mock gcode marker. Real mode
// (ORCA_E2E_REAL=1, CI e2e-real job): expects real extruder moves (G1).
// The ORCA_E2E env contract replaces native dialogs in main (see
// apps/desktop/src/main/index.ts) — Playwright cannot drive them.
import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');
const MODEL_PATH = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/cube.stl');
const REAL = process.env.ORCA_E2E_REAL === '1';

interface LaunchResult {
  app: ElectronApplication;
  exportPath: string;
}

async function launchApp(): Promise<LaunchResult> {
  const exportDir = mkdtempSync(join(tmpdir(), 'orca-e2e-'));
  const exportPath = join(exportDir, 'out.gcode');
  const app = await _electron.launch({
    args: ['.'],
    cwd: DESKTOP_ROOT,
    env: {
      ...process.env,
      ORCA_E2E: '1',
      ORCA_E2E_MODEL: MODEL_PATH,
      ORCA_E2E_EXPORT: exportPath,
    },
  });
  return { app, exportPath };
}

test('full v1 flow: open model → slice → preview → export gcode', async () => {
  const { app, exportPath } = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });

    // App ready: settings panel rendered from bridge metadata (mock presets).
    await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready');

    // Slice gated until a model is loaded.
    await expect(page.getByTestId('btn-slice')).toBeDisabled();
    await expect(page.getByTestId('btn-export')).toBeDisabled();

    // Open model (ORCA_E2E stub returns the fixture path).
    await page.getByTestId('btn-open').click();
    await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });

    // Slice → status flips to Sliced, preview + scrubber appear, export unlocks.
    await page.getByTestId('btn-slice').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 60_000 });
    await expect(page.getByTestId('viewport')).toBeVisible();
    await expect(page.getByTestId('layer-scrubber')).toBeVisible();
    await expect(page.getByTestId('btn-export')).toBeEnabled();

    // Export → file on disk with the expected gcode contents.
    await page.getByTestId('btn-export').click();
    await expect.poll(() => existsSync(exportPath), { timeout: 30_000 }).toBe(true);
    const gcode = readFileSync(exportPath, 'utf8');
    if (REAL) {
      expect(gcode).toContain('G1'); // real module: extruder moves
      expect(gcode).not.toContain('; mock gcode');
    } else {
      expect(gcode).toContain('; mock gcode (unit-test fixture)');
    }
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 8: The packaged-app probe — create `apps/desktop/e2e/packaged.e2e.ts`**

```ts
// apps/desktop/e2e/packaged.e2e.ts — probes the REAL wasm URL path in the
// PACKAGED app (file:// renderer): verifies T2's relative worker URL, the
// asarUnpack of out/renderer/wasm/** (fetch() cannot read inside asar), and
// that the worker loads its module (presets rendered) without renderer errors.
//
// Requires (run in order; public/wasm is gitignored so this never ships):
//   node scripts/stage-stub-wasm.mjs    # plain-JS stub module → public/wasm/
//   pnpm --filter desktop package:dir   # release/win-unpacked/ (no-mock build)
//   npx playwright test e2e/packaged.e2e.ts
// CI e2e-real covers the same path with the real module in the dev build.
import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');
const EXE = process.platform === 'win32'
  ? resolve(DESKTOP_ROOT, 'release/win-unpacked/OrcaSlicerNeo.exe')
  : resolve(DESKTOP_ROOT, 'release/linux-unpacked/orcaslicerne');
// darwin: release/mac/OrcaSlicerNeo.app/Contents/MacOS/OrcaSlicerNeo

test('packaged app loads the wasm module from the unpacked renderer', async () => {
  expect(existsSync(EXE), `packaged app missing — run package:dir first (${EXE})`).toBe(true);
  const rendererErrors: string[] = [];
  const app: ElectronApplication = await _electron.launch({ executablePath: EXE });
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (err) => rendererErrors.push(String(err)));
    // The stub module's getPresets answers — the worker's dynamic import of
    // ../wasm/orca_slice.js succeeded in the file:// context.
    await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: 30_000 });
    expect(rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 9: The stub module — create `apps/desktop/e2e/stub/orca_slice.js`**

Plain-JS ESM implementing the bridge contract minimally (same preset names as the mock so the probe's assertion is stable):

```js
// apps/desktop/e2e/stub/orca_slice.js — throwaway bridge-shaped module used
// ONLY by the packaged-app probe (staged into public/wasm/ by
// scripts/stage-stub-wasm.mjs, which is gitignored). Replaced by the real
// Emscripten artifact in CI (e2e-real). Implements just enough of the bridge
// for the app's boot path: init → getPresets → getOptionMetadata.
export default function makeStubModule() {
  return {
    ccall(name, ret, argTypes, args) {
      switch (name) {
        case 'orc_init': return { ok: true, prints: 1, filaments: 2, printers: 3 };
        case 'orc_get_presets': return { presets: [{ name: 'Bambu Lab X1 Carbon 0.4 nozzle' }, { name: 'Bambu Lab P1S 0.4 nozzle' }] };
        case 'orc_get_option_metadata': return {
          layer_height: { type: 'float' },
          wall_loops: { type: 'int' },
          sparse_infill_density: { type: 'percent' },
          sparse_infill_pattern: { type: 'enum', enum_values: ['grid', 'gyroid', 'lines'] },
        };
        default: return { ok: true };
      }
    },
    UTF8ToString: () => '',
    _malloc: () => 0,
    _free: () => {},
    HEAPU8: new Uint8Array(64 * 1024 * 1024),
    HEAPU32: new Uint32Array(64 * 1024 * 1024),
    HEAPF32: new Float32Array(64 * 1024 * 1024),
    addFunction: () => 0,
    removeFunction: () => {},
    FS: { writeFile() {}, readFile() { return new Uint8Array(0); } },
  };
}
```

- [ ] **Step 10: The staging script — create `scripts/stage-stub-wasm.mjs`**

```js
// scripts/stage-stub-wasm.mjs — temp staging for the packaged-app e2e probe:
// copies the plain-JS stub module (e2e/stub/orca_slice.js) into the renderer
// public dir in place of a real WASM build. Run before package:dir +
// packaged.e2e.ts; the stub is gitignored (public/wasm/) and never ships.
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'apps/desktop/e2e/stub/orca_slice.js');
const dst = join(root, 'apps/desktop/src/renderer/public/wasm/orca_slice.js');
await mkdir(dirname(dst), { recursive: true });
await copyFile(src, dst);
console.log('staged stub module — packaged probe only; run stage:wasm to replace with the real build');
```

- [ ] **Step 11: tsconfig include**

In `apps/desktop/tsconfig.node.json`, change the `"include"` to:

```json
  "include": ["electron.vite.config.ts", "playwright.config.ts", "e2e/**/*", "src/main/**/*", "src/preload/**/*", "src/shared/**/*"]
```

(e2e specs use explicit `import { test, expect } from '@playwright/test'` — no globals, so no `types` change.)

- [ ] **Step 12: Verify mock e2e locally (the M3 local gate)**

Run:
1. `pnpm --filter desktop typecheck` → exit 0 (now includes e2e + playwright config)
2. `pnpm --filter desktop test:e2e` → the full-flow spec passes against the mock-built app. Expected output ends with `1 passed`.
3. `pnpm test` (root) → still green (vitest include pattern `src/renderer/src/**/*.test.*` does not see `e2e/`).

- [ ] **Step 13: Verify the packaged probe locally**

Run:
1. `node scripts/stage-stub-wasm.mjs`
2. `pnpm --filter desktop package:dir`
3. `npx playwright test e2e/packaged.e2e.ts` → `1 passed`

This is the machine-local proof of T2 (file:// wasm URL) + asarUnpack. If the probe fails to find `preset-select`, check `apps/desktop/out/renderer/assets/slicer.worker-*.js` for the `../wasm/orca_slice.js` string (the fix) and that `release/win-unpacked/resources/app.asar.unpacked/out/renderer/wasm/orca_slice.js` exists.

Then clean the staged stub back out (the real artifact replaces it in CI):

Run: `rm apps/desktop/src/renderer/public/wasm/orca_slice.js` (the dir itself can stay; it's gitignored).

- [ ] **Step 14: Commit**

```bash
git add apps/desktop/playwright.config.ts apps/desktop/e2e apps/desktop/.env.e2e scripts/stage-stub-wasm.mjs apps/desktop/src/main/index.ts apps/desktop/src/renderer/src/components apps/desktop/tsconfig.node.json apps/desktop/package.json apps/desktop/pnpm-lock.yaml
git commit -m "test(m3): Playwright Electron e2e — full v1 flow (mock + real) and packaged-app probe"
```

---

## Task 4: Full preset bundle via `--preload-file`

**Files:**
- Modify: `packages/slicer-wasm/build.sh`, `packages/slicer-wasm/CMakeLists.txt`, `scripts/stage-wasm.mjs`

**Interfaces:**
- Consumes: submodule `packages/slicer-wasm/cpp/resources/profiles` (72 MB, all vendors); the `orc_init` data-dir mount point `/system` (unchanged — `PresetBundle::load_presets` reads `<data_dir>/system/*.json`, same as the curated embed).
- Produces: `orca_slice.data` beside `orca_slice.js` in `out/`; T5's CI stages all three files into the renderer. The bridge smoke + run-slice harness consume the new module unchanged (same mount).

**Why:** The M1 curated subset filtered third-party filament entries because their `inherits` chains referenced un-embedded vendor dirs and `load_vendor_configs_from_json` throws on the first missing file. With the FULL tree, every chain resolves — the fixpoint filter becomes unnecessary. `--preload-file` (not `--embed-file`) keeps the 72 MB out of the wasm binary (streamed into MEMFS at startup; heap grows via the existing `ALLOW_MEMORY_GROWTH`). Emscripten auto-loads `orca_slice.data` from the module script's directory (the staged `/wasm/` dir), so no `locateFile` override is needed.

- [ ] **Step 1: build.sh — replace the curated embed with a preload-file**

In `packages/slicer-wasm/build.sh`:

1. Delete the whole `# ---------------- Curated preset subset (for orc_init) ----------------` block (the `embed_presets()` function and its call site at the line right before the configure step) and replace it with:

```bash
# ---------------- Full preset bundle (for orc_init) ----------------
# M3: the full resources/profiles tree via --preload-file, mounted at /system
# — the same location the M1 curated embed used, so PresetBundle::load_presets
# and the harnesses are unchanged. With the full tree every third-party
# filament inherits chain resolves, so the M1 curated fixpoint filter is gone.
# Override WASM_PROFILES_DIR for a lighter local build (e.g. a curated dir);
# CI and packaging always use the full tree.
WASM_PROFILES_DIR="${WASM_PROFILES_DIR:-$ORCA_SRC/resources/profiles}"
log "Preset bundle: $WASM_PROFILES_DIR"
```

2. In the `emcmake cmake` configure call, replace the line:

```
  -DEMBED_FILE="$WORK_DIR/embed/system@/system" \
```

with:

```
  -DPRELOAD_FILE="$WASM_PROFILES_DIR@/system" \
```

3. In the artifact-collection block (after the `orca_slice.wasm` copy), add:

```bash
cp -f "$BUILD_DIR"/orca_slice.data "$OUT_DIR"/ 2>/dev/null || true
```

- [ ] **Step 2: CMakeLists.txt — EMBED_FILE → PRELOAD_FILE**

In `packages/slicer-wasm/CMakeLists.txt`, replace the trailing block:

```cmake
if(DEFINED EMBED_FILE AND NOT "${EMBED_FILE}" STREQUAL "")
  target_link_options(orca_slice PRIVATE "--embed-file=${EMBED_FILE}")
endif()
```

with:

```cmake
# Full vendor preset bundle (72 MB) via preload-file: the .data file is
# streamed into MEMFS at module start and the heap grows (ALLOW_MEMORY_GROWTH)
# — embed-file would bloat the wasm binary instead.
if(DEFINED PRELOAD_FILE AND NOT "${PRELOAD_FILE}" STREQUAL "")
  target_link_options(orca_slice PRIVATE "--preload-file=${PRELOAD_FILE}")
endif()
```

- [ ] **Step 3: stage-wasm.mjs — copy the .data file**

In `scripts/stage-wasm.mjs`, change the copy loop to:

```js
for (const f of ['orca_slice.js', 'orca_slice.wasm', 'orca_slice.data']) {
```

- [ ] **Step 4: Verify at config level (no emsdk on this machine)**

This machine has no emsdk (M2 deferral ruling), so the module cannot be rebuilt here. Verify:
1. `bash -n packages/slicer-wasm/build.sh` → exit 0 (syntax).
2. `grep -n "PRELOAD_FILE\|WASM_PROFILES_DIR\|orca_slice.data" packages/slicer-wasm/build.sh packages/slicer-wasm/CMakeLists.txt scripts/stage-wasm.mjs` → all three files reference the new mechanism, and no `EMBED_FILE` / `embed_presets` references remain.
3. The harnesses need no edits (mount unchanged): `grep -n "system" packages/slicer-wasm/harness/*.mjs` shows they stage/expect `/system` paths (record what you find in the report).

The real verification is the CI wasm job (Task 5): full build + both harnesses against the preload-file module. Record this deferral in the report and in the notes doc (Task 8).

- [ ] **Step 5: Commit**

```bash
git add packages/slicer-wasm/build.sh packages/slicer-wasm/CMakeLists.txt scripts/stage-wasm.mjs
git commit -m "feat(m3): full resources/profiles via --preload-file (replaces curated embed)"
```

---

## Task 5: GitHub Actions CI matrix

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: T1 `package` script + electron-builder.yml; T4 preload-file artifact (`orca_slice.data`); T3 `test:e2e` / `test:e2e:real` scripts + `ORCA_E2E_*` env contract; the existing harnesses (`run-slice.mjs`, `bridge-smoke.mjs`); `scripts/stage-wasm.mjs`.
- Produces: the CI pipeline. The wasm job is the first real execution of the M2-deferred WASM build + bridge verification; expect the AGENTS.md iterate loop on first run (fix in this repo, re-run CI).

**Design decisions:**
- **One wasm artifact, six packages**: the wasm job builds the module once; `actions/upload-artifact` carries `orca_slice.{js,wasm,data}` into the package matrix and e2e-real.
- **Cross-target packaging without arm runners**: windows-latest builds win x64+arm64 NSIS (electron-builder downloads the arm64 Electron dist); ubuntu-latest builds linux x64+arm64 AppImage (electron-builder cross-builds arm64 on x64, downloading the arm64 Electron dist — no qemu needed for packaging); macos-13 → DMG x64; macos-14 → DMG arm64.
- **Disk budget**: the WASM build needs ~50 GB on the spike machine; GitHub-hosted runners have ~14 GB. Cache the dependency stage (Eigen/cereal/Boost sources + headers + the 12 wasm64 Boost archives) keyed on the script SHAs + submodule SHA so the first run is the only expensive one; Boost's build intermediates (`bin.v2`) are transient and live inside the cached `deps/` dir only during the build — the cache stores the staged result. If the first run still exhausts disk, the fix loop is documented in the job's comment (e.g. `--with-…` prune) — treat it as the AGENTS.md iterate loop, not a plan failure.
- **emsdk 6.0.4** per the design doc's risk table ("Spike ran it on Emscripten 6.0.4"). `jaxvanyang/setup-emsdk` with `version: '6.0.4'`; if that action does not know the tag, use the emsdk GitHub release asset directly — record what worked in the report.
- **e2e on Linux needs a display**: wrap Playwright in `xvfb-run -a`.
- **pnpm**: `corepack enable` then `actions/setup-node@v4` with `cache: pnpm`.

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
# .github/workflows/ci.yml — M3 CI matrix (Grand Plan M3, high-level plan Epic 3.2).
#
# Jobs:
#   wasm       build the ONE module (emsdk 6.0.4, per the design doc's risk
#              table) + run both harnesses (run-slice smoke, bridge-smoke) —
#              this is the first real execution of the M2-deferred WASM build
#              and binary-buffer bridge verification. Artifact: orca_slice.{js,wasm,data}.
#   unit       vitest + typecheck + electron-vite build (all packages)
#   e2e-mock   Playwright full v1 flow against the mock-built app (no emsdk)
#   e2e-real   Playwright full v1 flow against the REAL module (staged artifact)
#   package    electron-builder matrix → all six targets, same wasm artifact
#
# WASM build notes (AGENTS.md "WASM Build Workflow"): missing <tbb/X.h> →
# add to TBB_HEADERS; undefined symbol → DROP_PATTERNS or stubs; API drift →
# bridge signatures. First runs will iterate; fixes land in this repo and CI
# re-runs. Hosted runners have ~14 GB disk; the dep cache below makes the
# ~50 GB-class boost build a first-run-only cost.
name: CI
on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

env:
  NODE_VERSION: "22.14.0" # Volta-pinned

jobs:
  wasm:
    name: WASM build + smoke
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
          fetch-depth: 0 # version header reads `git describe` on the submodule
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
      - uses: jaxvanyang/setup-emsdk@v1
        with:
          version: "6.0.4" # spike-validated (design doc risk table)
      - name: Cache deps (Eigen/Boost sources + wasm64 archives + cereal)
        uses: actions/cache@v4
        with:
          path: packages/slicer-wasm/.work/deps
          key: wasm-deps-${{ hashFiles('packages/slicer-wasm/fetch-deps.sh', 'packages/slicer-wasm/build-boost-wasm64.sh') }}-${{ hashFiles('packages/slicer-wasm/build.sh') }}
          restore-keys: |
            wasm-deps-${{ hashFiles('packages/slicer-wasm/fetch-deps.sh', 'packages/slicer-wasm/build-boost-wasm64.sh') }}-
      - name: Fetch deps (Eigen/Boost/cereal)
        run: bash packages/slicer-wasm/fetch-deps.sh
      - name: Build Boost 1.84 wasm64 archives
        run: bash packages/slicer-wasm/build-boost-wasm64.sh
      - name: Configure + build the module (preload-file bundle included)
        run: bash packages/slicer-wasm/build.sh
      - name: Smoke — slice cube.stl end to end
        run: node packages/slicer-wasm/harness/run-slice.mjs --module packages/slicer-wasm/out/orca_slice.js --stl packages/slicer-wasm/fixtures/cube.stl --config packages/slicer-wasm/fixtures/config.json
      - name: Bridge smoke — binary-buffer contract (M2 deferred verification)
        run: node packages/slicer-wasm/harness/bridge-smoke.mjs packages/slicer-wasm/out/orca_slice.js packages/slicer-wasm/fixtures/cube.stl
      - name: Upload the one module (all six packages + e2e-real use it)
        uses: actions/upload-artifact@v4
        with:
          name: orca-slice
          path: |
            packages/slicer-wasm/out/orca_slice.js
            packages/slicer-wasm/out/orca_slice.wasm
            packages/slicer-wasm/out/orca_slice.data
          retention-days: 7

  unit:
    name: Unit + typecheck + app build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r test
      - run: pnpm -r typecheck
      - run: pnpm --filter desktop build

  e2e-mock:
    name: e2e (mock module)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - name: e2e — full v1 flow (mock-built app)
        run: xvfb-run -a pnpm --filter desktop test:e2e

  e2e-real:
    name: e2e (real module)
    needs: wasm
    runs-on: ubuntu-latest
    env:
      ORCA_E2E_REAL: "1"
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - uses: actions/download-artifact@v4
        with:
          name: orca-slice
          path: packages/slicer-wasm/out
      - run: node scripts/stage-wasm.mjs
      - name: e2e — full v1 flow (real module, asserts G1 moves in exported gcode)
        run: xvfb-run -a pnpm --filter desktop test:e2e:real

  package:
    name: Package (${{ matrix.name }})
    needs: wasm
    strategy:
      fail-fast: false
      matrix:
        include:
          - name: win x64 + arm64 (NSIS)
            os: windows-latest
            args: --win
          - name: linux x64 + arm64 (AppImage)
            os: ubuntu-latest
            args: --linux
          - name: mac x64 (DMG)
            os: macos-13
            args: --mac --x64
          - name: mac arm64 (DMG)
            os: macos-14
            args: --mac --arm64
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - uses: actions/download-artifact@v4
        with:
          name: orca-slice
          path: packages/slicer-wasm/out
      - run: node scripts/stage-wasm.mjs
      - name: electron-builder (${{ matrix.name }})
        run: pnpm --filter desktop package -- ${{ matrix.args }}
      - name: Upload installer(s)
        uses: actions/upload-artifact@v4
        with:
          name: installers-${{ matrix.name }}
          path: |
            apps/desktop/release/*.exe
            apps/desktop/release/*.AppImage
            apps/desktop/release/*.dmg
          if-no-files-found: error
          retention-days: 14
```

- [ ] **Step 2: Verify the workflow file locally**

This machine has no emsdk and no GitHub runner — execution is deferred to the first push (T8 records the deferral). Local verification:
1. `npx --yes yaml-lint .github/workflows/ci.yml` (or `python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"` if PyYAML is present) → parses.
2. Re-read the workflow for self-consistency: every `pnpm` step runs after `corepack enable`; `package` job's `pnpm --filter desktop package -- <args>` expands to `electron-vite build && electron-builder --publish never --win` etc.; download-artifact path matches upload; `ORCA_E2E_REAL` is set on the e2e-real job.
3. `git status --porcelain` shows only the new workflow file.

Expected first-push outcomes (record in the notes doc, Task 8): the wasm job iterates per AGENTS.md; the package matrix produces six unsigned installers.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(m3): GitHub Actions matrix — wasm+smoke, unit, e2e (mock+real), six-target packaging"
```

---

## Task 6: AGPL-3.0 LICENSE + source-offer notes

**Files:**
- Create: `LICENSE` (root), `SOURCE_OFFER.md` (root)
- Modify: `apps/desktop/electron-builder.yml` (nsis license), root + desktop `package.json` (license field)

**Interfaces:**
- Consumes: T1's `electron-builder.yml` (this task adds the `nsis.license` line).
- Produces: the installer shows the AGPL text (NSIS license page); root metadata carries the license; the repo records the corresponding-source offer.

**Why:** The repo is a fork of AGPL OrcaSlicer — AGPL-3.0 throughout (Global Constraint 8). Distributing the app (installers, CI artifacts) triggers AGPL §4/§13 obligations: a copy of the license with the work, and an offer of corresponding source.

- [ ] **Step 1: Fetch the canonical AGPL-3.0 text to `LICENSE`**

Run (from the repo root):

```bash
curl -fsSL https://www.gnu.org/licenses/agpl-3.0.txt -o LICENSE
```

Then verify it is the canonical text (not an error page):

```bash
head -5 LICENSE
```

Expected first lines: `GNU AFFERO GENERAL PUBLIC LICENSE` / `Version 3, 19 November 2007`. If the fetch fails (offline), copy the text from the submodule's copy if present (`git -C packages/slicer-wasm/cpp show HEAD:LICENSE` — OrcaSlicer is AGPL; verify the same first line) and note the source in the report. Never hand-write the license text.

- [ ] **Step 2: Create `SOURCE_OFFER.md`**

```markdown
# Corresponding Source Offer

OrcaSlicerNeo is free software distributed under the GNU Affero General Public
License, version 3 (see `LICENSE`).

The corresponding source code is published in the project repository:

- **Repository:** <https://github.com/Noisyfox/OrcaSlicerNeo>
- **Branch:** `main`
- **C++ slicing core:** `libslic3r` (fork of OrcaSlicer, AGPL-3.0), pinned as a
  git submodule at `packages/slicer-wasm/cpp` (see
  `packages/slicer-wasm/cpp` — commit SHA in `.gitmodules`/`git submodule status`)

The commit this build was produced from is recorded in the version header
(`SLIC3R_VERSION` / `GIT_COMMIT_HASH` in the generated
`libslic3r_version.h`), which is embedded in the G-code metadata of every
exported file.

Build instructions: see `doc/2026-08-12-wasm-build-notes.md` (WASM core) and
`doc/2026-08-14-m3-implementation-notes.md` (packaging pipeline).
```

- [ ] **Step 3: License metadata — package.json fields**

Root `package.json`: add `"license": "AGPL-3.0"` (alphabetically between `"description"` and `"packageManager"`).

`apps/desktop/package.json`: add `"license": "AGPL-3.0"` next to `"author"`.

- [ ] **Step 4: Installer license page**

In `apps/desktop/electron-builder.yml`, extend the `nsis:` block:

```yaml
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  shortcutName: OrcaSlicerNeo
  license: ../LICENSE # AGPL-3.0 text shown on the NSIS license page
```

(electron-builder resolves the path relative to the config file's directory. If the Windows build rejects the extension, copy the text to `apps/desktop/build/AGPL-3.0.txt` and point there — record which path worked in the report.)

- [ ] **Step 5: Verify**

1. `head -5 LICENSE` shows the AGPL header; `wc -l LICENSE` ~ 660 lines (the canonical text).
2. `pnpm --filter desktop package:win` → still exits 0; the NSIS installer now includes a license page.
3. `pnpm -r typecheck` → still green (JSON edits only).

- [ ] **Step 6: Commit**

```bash
git add LICENSE SOURCE_OFFER.md package.json apps/desktop/package.json apps/desktop/electron-builder.yml
git commit -m "license(m3): AGPL-3.0 text, source offer, installer license page"
```

---

## Task 7: Slice cross-check vs desktop OrcaSlicer

**Files:**
- Create: `scripts/crosscheck-slice.mjs`

**Interfaces:**
- Consumes: two gcode files — the WASM module's export (via `run-slice.mjs` or the harness bridge) and desktop OrcaSlicer's headless export for the same model/profile. Both files are produced on the emsdk machine (the desktop binary is not available here and cannot be built without the full native toolchain).
- Produces: the Grand Plan M3 checkbox's procedure + script. **Execution is deferred** to an emsdk machine with desktop OrcaSlicer (M2 precedent: emsdk deferral ruling) — recorded in the notes doc (Task 8).

**Why:** The Grand Plan requires slice output consistent with desktop OrcaSlicer for the same model/profile (the design's GO criterion, carried from the spike). The comparison surface: header metadata, layer count, total filament, and the presence of extruder moves — numeric tolerances, not byte equality (the WASM build pins a different libslic3r SHA than a given desktop release).

- [ ] **Step 1: Create `scripts/crosscheck-slice.mjs`**

```js
// scripts/crosscheck-slice.mjs — compare the WASM module's G-code output
// against desktop OrcaSlicer's for the same model/profile (Grand Plan M3:
// "Slice-output cross-check vs desktop OrcaSlicer"). Numeric tolerances, not
// byte equality — the module pins a different libslic3r SHA than desktop.
//
// Usage:
//   node scripts/crosscheck-slice.mjs <wasm.gcode> <desktop.gcode>
//
// Exit 0 = PASS (all comparisons within tolerance); 1 = FAIL with a report.
// Executed manually on an emsdk machine with desktop OrcaSlicer installed
// (headless export: orca-slicer --export-gcode --output out.gcode
//  --load profile.ini cube.stl) — see doc/2026-08-14-m3-implementation-notes.md.
import { readFileSync } from 'node:fs';

const FILAMENT_RE = /; total filament used \[mm\^3\] = ([\d.]+)/;
const LAYER_COUNT_RE = /;LAYER_COUNT:(\d+)/;
const TIME_RE = /; total estimated printing time .* = (\d+)/;

const [wasmPath, desktopPath] = process.argv.slice(2);
if (!wasmPath || !desktopPath) {
  console.error('usage: node scripts/crosscheck-slice.mjs <wasm.gcode> <desktop.gcode>');
  process.exit(2);
}

function parse(path) {
  const text = readFileSync(path, 'utf8');
  const layerCount = Number(text.match(LAYER_COUNT_RE)?.[1]);
  const filament = Number(text.match(FILAMENT_RE)?.[1]);
  const printTimeMin = Number(text.match(TIME_RE)?.[1]);
  const g1Moves = (text.match(/G1 /g) ?? []).length;
  return { path, text, layerCount, filament, printTimeMin, g1Moves };
}

function check(ok, label, actual, expected, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${label}: wasm=${actual} desktop=${expected}${detail ? ' — ' + detail : ''}`);
  return ok;
}

const wasm = parse(wasmPath);
const desktop = parse(desktopPath);
let pass = true;

pass = check(wasm.g1Moves > 0, 'extruder moves present', wasm.g1Moves, desktop.g1Moves, 'wasm must contain G1 moves') && pass;
pass = check(wasm.layerCount === desktop.layerCount, 'layer count', wasm.layerCount, desktop.layerCount) && pass;
if (Number.isFinite(wasm.filament) && Number.isFinite(desktop.filament)) {
  const rel = Math.abs(wasm.filament - desktop.filament) / desktop.filament;
  pass = check(rel <= 0.05, 'total filament (5% tolerance)', wasm.filament.toFixed(2), desktop.filament.toFixed(2), `rel diff ${(rel * 100).toFixed(2)}%`) && pass;
} else {
  console.log('SKIP  total filament — missing from one output (profile differs?)');
}

console.log(pass ? '\nCROSS-CHECK: PASS' : '\nCROSS-CHECK: FAIL');
process.exit(pass ? 0 : 1);
```

- [ ] **Step 2: Verify the script's failure/parse paths locally**

Run (no emsdk needed — synthetic inputs):
1. `node scripts/crosscheck-slice.mjs` → exit 2 with usage text.
2. Create two tiny fixtures in a temp dir (`mktemp`): one with `;LAYER_COUNT:40` + `; total filament used [mm^3] = 100.0` + a `G1 X1 Y1` line, the other identical but filament `105.0` → expect PASS (5% tolerance). Then set the desktop file's layer count to `41` → expect FAIL and exit 1.
3. Delete the temp fixtures.

- [ ] **Step 3: Document the deferred procedure**

Add a "Slice cross-check (deferred)" section to `doc/2026-08-14-m3-implementation-notes.md` (Task 8 writes the doc — this task appends the section's content to the plan now; Task 8 includes it): commands to produce both gcodes on the emsdk machine, the tolerance rationale, and the expected first-difference candidates (SLA/dropped features are excluded; differences are expected only in version-stamped metadata).

- [ ] **Step 4: Commit**

```bash
git add scripts/crosscheck-slice.mjs
git commit -m "test(m3): slice cross-check script vs desktop OrcaSlicer (procedure, deferred execution)"
```

---

## Task 8: Docs sync — Grand Plan, dev plan, notes doc

**Files:**
- Modify: `spec/Grand Plan.md`, `doc/high_level_dev_plan.md`
- Create: `doc/2026-08-14-m3-implementation-notes.md`

**Interfaces:**
- Consumes: every deliverable of Tasks 1–7 and their verification outcomes (test counts, build results, deferrals) — copy exact numbers from the task reports, never invent them.

- [ ] **Step 1: Grand Plan M3 section — check the boxes**

In `spec/Grand Plan.md`, replace the M3 section:

```markdown
## Milestone 3: Packaging & Hardening (design Phase F)

> [!info] Target: **TBD**

- [ ] electron-builder: Windows x64/arm64 (NSIS), Linux x64/arm64 (AppImage),
      macOS x64/arm64 (DMG) — all six ship the same `.wasm`
- [ ] Playwright Electron e2e covering the full v1 flow
- [ ] GitHub Actions CI matrix (build WASM + app, run smoke/unit/e2e)
- [ ] Full `resources/profiles` bundle (`--preload-file`) replacing the
      curated subset
- [ ] Slice-output cross-check vs desktop OrcaSlicer (same model + profile)
- [ ] Root `LICENSE` (AGPL-3.0) and source-offer notes
```

with:

```markdown
## Milestone 3: Packaging & Hardening (design Phase F)

> [!info] Target: **2026-08-14** (delivered)

- [x] electron-builder: Windows x64/arm64 (NSIS), Linux x64/arm64 (AppImage),
      macOS x64/arm64 (DMG) — all six ship the same `.wasm`
- [x] Playwright Electron e2e covering the full v1 flow
- [x] GitHub Actions CI matrix (build WASM + app, run smoke/unit/e2e)
- [x] Full `resources/profiles` bundle (`--preload-file`) replacing the
      curated subset
- [x] Slice-output cross-check vs desktop OrcaSlicer (same model + profile)
- [x] Root `LICENSE` (AGPL-3.0) and source-offer notes

> [!warning] Deferred verification (emsdk / cross-check)
> The WASM build, both harnesses, e2e-real, and the six-target package matrix
> execute in GitHub Actions on the first push after this milestone (no emsdk on
> the delivery machine — M2 precedent). The slice cross-check needs desktop
> OrcaSlicer on an emsdk machine; the procedure + script shipped
> (`scripts/crosscheck-slice.mjs`). See
> `doc/2026-08-14-m3-implementation-notes.md`.
```

- [ ] **Step 2: high_level_dev_plan.md — M3 status + epic notes**

In `doc/high_level_dev_plan.md`, replace the whole `### Milestone 3 — Packaging & Hardening (design Phase F)` section (currently "**Epic 3.1: electron-builder**" through "**Epic 3.3: Full preset bundle**", i.e. the epics with no status line) with:

```markdown
### Milestone 3 — Packaging & Hardening (design Phase F)

> **Status: delivered 2026-08-14.** electron-builder config for all six
> targets (win NSIS x64/arm64, linux AppImage x64/arm64, mac DMG x64/arm64)
> sharing one staged WASM artifact; Playwright Electron e2e driving the full
> v1 flow (mock module locally, real module in CI — asserts exported gcode
> contents) plus a packaged-app probe of the file:// wasm URL path; GitHub
> Actions matrix (wasm+smoke, unit/typecheck, e2e-mock, e2e-real, package);
> full `resources/profiles` bundle via `--preload-file` (replaces the M1
> curated subset); root `LICENSE` (AGPL-3.0) + `SOURCE_OFFER.md`; slice
> cross-check procedure + script. Deferred to first CI push: the WASM
> rebuild + harnesses + e2e-real + six-target packaging (no emsdk on the
> delivery machine — M2 precedent; the CI wasm job is the first real
> execution of the M2-deferred bridge verification). Slice cross-check
> additionally needs desktop OrcaSlicer (emsdk machine).
> See `doc/2026-08-14-m3-implementation-notes.md`.

**Epic 3.1: electron-builder**
- Config (electron-builder.yml): win x64/arm64 (NSIS), linux x64/arm64
  (AppImage), mac x64/arm64 (DMG); unsigned v1; `asarUnpack` for
  `out/renderer/wasm/**` (fetch() cannot read inside asar); NSIS license
  page shows AGPL-3.0. One `stage:wasm` artifact feeds all six bundles.

**Epic 3.2: e2e + CI**
- Playwright Electron (`@playwright/test`, `_electron.launch`): full v1 flow
  spec (open → slice → preview → export, asserts gcode file contents) —
  mock build locally, real module in CI (`ORCA_E2E_REAL=1`); `ORCA_E2E`
  env-gated native-dialog stub in main (Playwright cannot drive native
  dialogs). Packaged-app probe spec (stub module, `package:dir`).
- GitHub Actions: wasm job (emsdk 6.0.4, dep cache, both harnesses,
  artifact = orca_slice.{js,wasm,data}), unit, e2e-mock, e2e-real, package
  matrix (win/ubuntu/macos-13/macos-14 → six targets, no arm runners).

**Epic 3.3: Full preset bundle**
- `--preload-file` of the full `resources/profiles` (72 MB) mounted at
  `/system` replaces the curated `--embed-file` subset
  (`WASM_PROFILES_DIR` override for lighter local builds); `orca_slice.data`
  staged alongside the module; heap grows at startup (ALLOW_MEMORY_GROWTH).
- Root `LICENSE` (AGPL-3.0 canonical text) + `SOURCE_OFFER.md`; installer
  license page; `license` fields in package.jsons.
```

- [ ] **Step 3: Create `doc/2026-08-14-m3-implementation-notes.md`**

The notes doc records what a fresh engineer needs for M3 (same style as the M2 notes doc — contracts, decisions, verify steps, deferrals):

```markdown
# M3 Implementation Notes — Packaging & Hardening

Scope: the record a fresh engineer needs for the M3 milestone (design Phase F):
what was delivered (Tasks 1–8 of `doc/2026-08-14-m3-packaging-hardening-plan.md`),
the packaged-app asset pipeline, the e2e modes and env contracts, the CI
matrix layout, and every deferral with its verification path. Companion to the
approved design, `spec/Grand Plan.md`, and `doc/high_level_dev_plan.md`.

## Packaged-app asset pipeline

- Worker factory URL (`slicer.worker.ts`): `import.meta.env.PROD ?
  '../wasm/orca_slice.js' : '/wasm/orca_slice.js'`. Dev: Vite serves the
  renderer `public/` dir at `/`. Prod: the page is `file://` (absolute paths
  hit the filesystem root); the worker chunk lives in
  `out/renderer/assets/`, so the relative specifier lands at
  `out/renderer/wasm/orca_slice.js`. Emscripten loads `.wasm`/`.data`
  relative to the module script — same dir, no `locateFile` override.
- `asarUnpack: out/renderer/wasm/**` — the renderer fetches the wasm/data
  over `file://`; `fetch()` cannot read inside asar.
- `scripts/stage-wasm.mjs` stages `orca_slice.{js,wasm,data}` into
  `apps/desktop/src/renderer/public/wasm/` (gitignored) → `out/renderer/wasm/`
  at build. Packaging runs stage:wasm first; CI downloads the one artifact.
- `e2e/stub/orca_slice.js` + `scripts/stage-stub-wasm.mjs`: plain-JS
  bridge-shaped module used ONLY by the packaged-app probe
  (`e2e/packaged.e2e.ts`) to exercise the file:// URL path without emsdk.

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
- Packaged probe: `stage-stub-wasm` → `package:dir` → spec asserts
  `preset-select` visible (worker's dynamic import succeeded in file://) and
  no renderer `pageerror`s.

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
  uploaded (retention 14 d), unsigned.
- Known first-run iteration surface (AGENTS.md loop): TBB_HEADERS /
  DROP_PATTERNS / stubs / bridge API drift; ~14 GB runner disk vs the
  ~50 GB-class boost build — the dep cache makes it first-run-only.

## Full preset bundle

- `--preload-file "$WASM_PROFILES_DIR@/system"` (default
  `cpp/resources/profiles`, 72 MB) replaces the M1 curated `--embed-file`
  subset. Mount unchanged (`/system`) → harnesses and `orc_init` untouched.
  With the full tree every third-party filament `inherits` chain resolves, so
  the M1 fixpoint filter is gone. Startup: `.data` streams into MEMFS and the
  heap grows (ALLOW_MEMORY_GROWTH; INITIAL_MEMORY 64 MB stays).

## Licensing

- Root `LICENSE`: canonical AGPL-3.0 text (fetched from gnu.org).
- Root `SOURCE_OFFER.md`: repository URL, branch, submodule pin, build
  pointers (AGPL §13).
- NSIS installer shows the license page (`nsis.license` in
  electron-builder.yml); `license` fields on both package.jsons.

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

## Deferred verification (first CI push / emsdk machine)

- WASM rebuild + run-slice + bridge-smoke (no emsdk locally) — CI `wasm` job.
- e2e with the real module — CI `e2e-real` job.
- Six-target packaging (win x64 verified locally; arm64 + linux + mac are
  matrix builds) — CI `package` job.
- Slice cross-check — emsdk machine + desktop OrcaSlicer (manual).
- Manual GUI pass on a packaged installer (`package:win` → install → run).
```

- [ ] **Step 4: Verify**

1. Re-read the three files; every checkbox/status line matches what the task reports say (exact test counts, exact deferrals). If a task's verification differed from the plan (e.g. a fix round changed behavior), the notes doc must say what actually happened — never a plan-verbatim claim for an outcome that didn't happen.
2. `git status --porcelain` shows only the three doc files.

- [ ] **Step 5: Commit**

```bash
git add spec/Grand Plan.md doc/high_level_dev_plan.md doc/2026-08-14-m3-implementation-notes.md
git commit -m "docs(m3): milestone checkboxes, dev-plan status, implementation notes"
```

---

## Self-Review (run before execution)

**Spec coverage** — every design §Packaging / §Testing requirement and every Grand Plan M3 checkbox maps to a task:
- 6 targets same `.wasm` → T1 config + T5 matrix (one artifact) ✓
- Playwright e2e, assert gcode contents → T3 (mock local, real CI) ✓
- CI matrix builds WASM + app, runs smoke/unit/e2e → T5 ✓
- Full profiles preload-file → T4 ✓
- Slice cross-check → T7 (procedure + script; deferred execution) ✓
- LICENSE + source offer → T6 ✓
- Packaged-app wasm URL (no explicit checkbox, but a hard requirement for any packaged e2e to work) → T2 ✓

**Placeholder scan** — no TBD/TODO in task steps; every file's content is written out. The two genuinely environment-dependent values are pinned to named sources: emsdk `6.0.4` (design doc risk table), `@playwright/test ^1.49` floor (Electron 34 support; implementer may take latest 1.x).

**Type/name consistency** — `ORCA_E2E*` env names identical across T3 (main + spec) and T5 (job env); test ids identical across T3 (components + specs); `orca_slice.data` identical across T4 (build.sh, CMakeLists, stage-wasm) and T5 (artifact paths); `WASM_PROFILES_DIR` identical across T4's build.sh and its CMake `-DPRELOAD_FILE`; `stage:wasm` script name in root package.json matches T4/T5 usage; the `package` script name matches T5's `pnpm --filter desktop package --`.

## Execution Handoff

Two execution options:

**1. Subagent-Driven (recommended — the M2 mode)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints for review.

Which approach?
