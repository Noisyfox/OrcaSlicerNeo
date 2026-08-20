# M9 Step 0 — Shared-App Migration Baseline

**Date:** 2026-08-20  
**Application state under test:** `0faeeba` (`test(m9): isolate mock and real electron fixtures`)  
**Plan step:** [Web–Electron Shared Application implementation plan, §4](2026-08-19-web-electron-shared-implementation-plan.md)

This note records the current reproducible Electron behavior and host boundary
for M9 acceptance. It is not a historical pre-extraction snapshot: the
shared-app extraction and later M9 work already exist in repository history.
The note records the observable contract only; it does not make AppConfig or
Electron IPC a Web requirement.

## Verification commands

Run from the repository root on the baseline commit:

```powershell
pnpm test
pnpm typecheck
pnpm --filter desktop test:e2e
```

The first command runs the workspace Vitest suites, the second checks all
workspace TypeScript projects, and the third builds the mock Electron app and
runs the focused desktop E2E set (`app.e2e.ts`, `slice-error.e2e.ts`, and
`select-scroll.e2e.ts`). The current mock result is **3 passed, 1 skipped**;
the skipped test is the intentionally skipped rejecting-model case in
`slice-error.e2e.ts`.

The package does not define a separate `test:e2e:real` script. The actual
real-module command is:

```powershell
ORCA_E2E_REAL=1 pnpm --filter desktop test:e2e
```

On the current baseline this real Electron run is **2 passed, 2 failed**.
The passing tests are the scene-selection and slice-error cases. The full
flow fails because the requested `Creality Ender-3 0.4 nozzle` profile is not
present in the loaded fixture; the select-scroll test fails because the real
sidebar has no scrollable range in this environment. These failures are
recorded evidence, not green acceptance claims.

## Expected core flow and E2E coverage

The existing tests cover each baseline checklist behavior without adding a
duplicate checklist test:

| Behavior | Existing coverage |
| --- | --- |
| Boot and preset readiness | `full v1 flow: add models → slice → preview → export gcode` in `apps/desktop/e2e/app.e2e.ts` |
| Model add | Same full-flow test, `btn-add-model` |
| Profile selection | Same full-flow test, `preset-select` search and exact printer pick |
| Model transform | Same full-flow test, viewport drag pixel-change assertion; detailed gizmo/numeric transform coverage is in `scene selection: gizmo priority, multi-instance move, slice sync, reset` |
| Slice | Same full-flow test, `btn-slice` and `Sliced` status |
| Toolpath/layer preview | Same full-flow test, viewport, layer scrubber, and layer-change pixel assertion |
| Export | Same full-flow test, `btn-export` and output G-code marker |
| Clear scene | Same full-flow test, `btn-clear-scene` and disabled slice/export assertions |

The expected flow is therefore: boot → wait for preset readiness → select a
printer profile → add STL model → transform/inspect the model → slice → inspect
toolpath and scrub layers → export G-code → clear the scene. The focused
selection test supplements transform behavior and is not another copy of the
full flow.

## Current public Electron IPC

The preload exposes `window.orca` from `apps/desktop/src/preload/index.ts`.
Its current public operations and corresponding channels in
`apps/desktop/src/shared/ipc.ts` are:

| API | Channel | Current role |
| --- | --- | --- |
| `openFileDialog(filters)` | `dialog:openFile` | choose STL/3MF input |
| `saveFileDialog(defaultName, filters)` | `dialog:saveFile` | choose G-code output |
| `readFile(path)` | `file:read` | read selected model bytes |
| `writeFile(path, bytes)` | `file:write` | write exported G-code |
| `appConfig.load()` | `appConfig:load` | load persisted temporary AppConfig JSON |
| `appConfig.save(json)` | `appConfig:save` | save persisted temporary AppConfig JSON |

`window.orca.version` and `window.orca.platform` are metadata values used by
the current desktop chrome. Absolute paths are currently private to the
Electron renderer/main handoff; they are not a shared-Web contract.

## Temporary AppConfig behavior

`appConfig.load()` reads `userData/appconfig.json` when persistence is enabled
and returns `{ found, json }`; missing or invalid JSON is treated as a fresh
configuration. `appConfig.save(json)` writes the JSON for the single renderer
writer. This AppConfig model currently carries installed profile/selections
and legacy desktop preferences. It is explicitly temporary migration state and
will be retired in M9 Steps 8–9; Web behavior must not depend on it.

## Static renderer, Worker, and WASM URL layout

Electron serves the built renderer from an ephemeral loopback HTTP origin:
`http://127.0.0.1:<port>/index.html`. The main process serves the
`out/renderer` tree and applies COOP/COEP headers. Vite emits the module Worker
under `out/renderer/assets/`; the Worker resolves host assets relative to its
own URL. The current static layout is:

```text
out/renderer/index.html
out/renderer/assets/<worker-chunk>.js
out/renderer/wasm/threaded/orca_slice.js
out/renderer/wasm/threaded/orca_slice.wasm
out/renderer/wasm/threaded/orca_slice.data
out/renderer/wasm/serial/orca_slice.js
out/renderer/wasm/serial/orca_slice.wasm
out/renderer/wasm/serial/orca_slice.data
out/renderer/profiles/manifest.json
out/renderer/profiles/<bundled profile packages>
```

The Worker selects `wasm/threaded/` when the renderer is cross-origin isolated
and `wasm/serial/` otherwise. Emscripten `locateFile` points `.wasm` and
`.data` requests at the same selected directory. Mock E2E substitutes the
bridge-shaped mock module; it does not prove real WASM loading.

## Baseline scope

No full-UI screenshot snapshots are part of this baseline. Stable `data-testid`
locators and the focused viewport pixel assertions above are retained only for
detecting host-boundary regressions during extraction.
