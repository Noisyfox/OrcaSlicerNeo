# NODEFS Temporary File Validation

**Date:** 2026-10-02

**Status:** Functional feasibility validated in an isolated worktree based on remote main `86ce9f702f9d3112565f721832baf0f05ce47925`. Performance testing is excluded from acceptance at the user's request.

## Scope

Validate the existing temporary-file workflows using one shared threaded WASM artifact in Electron and Web. Electron threaded mounts a session-specific native temporary directory through NODEFS; Web and serial retain MEMFS. No Python runtime, plugin execution, or post-processing feature is included.

## Implementation

The existing threaded target links `-lnodefs.js`. Electron main creates one
`os.tmpdir()/orca-slicer-XXXXXX` directory per utility session and passes its
absolute path privately to the utility's Node Worker. The typed WASM client
mounts it at `/tmp` after the module factory resolves, before profile installation
or `orc_init`. Startup fails if NODEFS is missing or `/tmp` already contains
files; it never silently mounts over existing data.

The host setup follows the **successfully loaded** variant. Web has no native
directory option. Electron serial, including threaded-load fallback, retains
MEMFS. The remaining filesystem, including `/system` profiles, stays in MEMFS.
This uses a selective NODEFS mount, not NODERAWFS.

| Existing workflow | Temporary location | Handling |
| --- | --- | --- |
| Model upload, including STL/DRC/STEP | `/tmp/<sanitized filename>` | Existing upload retention lasts until session exit. |
| Slicer log | `/tmp/orca.log` | Same logger and flush policy; the file is created lazily when a record passes the configured severity filter. |
| Generation G-code | `/tmp/plate-result-<plate>-<incarnation>-<generation>.gcode` | Moved from the filesystem root; result receipts, replacement, preview indexing and export semantics are unchanged. |
| Project import/export | `/tmp/orca-project-<sequence>.3mf` and normalization/`.tmp` siblings | Existing per-operation cleanup remains in effect. |
| STEP preprocessing | `/tmp/temp.step` | `orc_init` now initializes `Slic3r::temporary_dir()` to `/tmp`. |
| Native model backup/3MF staging | `/tmp/orcaslicer_model/...` | Uses the same `Slic3r::temporary_dir()` setting. |

Source owners are
[`bridge_model_operations.cpp`](../packages/slicer-wasm/src/bridge_model_operations.cpp),
[`bridge_slicing_pipeline.cpp`](../packages/slicer-wasm/src/bridge_slicing_pipeline.cpp),
[`bridge_project_persistence.cpp`](../packages/slicer-wasm/src/bridge_project_persistence.cpp),
and the pinned upstream `STEP.cpp` / `Model.cpp`. The upstream submodule remains
unchanged at `489cbe91840ff97aaf4d8029009d5db410f32893`.

Main removes the exact owned directory after the utility exits, so open native
handles are closed first. Reloaded documents retain independent cleanup for
their old sessions. Normal application quit waits for outstanding process exits
and directory removal. A stop requested before Electron assigns a utility PID
is retried on `spawn`; unit tests cover immediate quit and document replacement.
Node Worker exit terminates its utility so main can clean up.

## Compatibility evidence

Both variants were freshly configured and compiled in this worktree with
Emscripten 6.0.4. Only the existing dependency archives and matching generated
headers were reused. The final incremental builds picked up all scaffold/C++
changes; the pinned upstream source was not edited.

The new Web test serves the exact unmodified threaded build outputs to the
browser and completes import, slice, GPU preview, normal export and a `/tmp`
File Manager download. The two downloads are byte-identical. It checks that
threading remains active and all three build artifacts were served.

| Shared threaded artifact | SHA-256 |
| --- | --- |
| `orca_slice.js` | `47a035fa44edf75303085bdc86655e9ef8aeacceb93f400434adf66192241d5c` |
| `orca_slice.wasm` | `1c4f43da7ce8695f23bfdc2a832059698b610eafd48100807e07f6638a91d8aa` |
| `orca_slice.data` | `31105d0d32a3f7ba60c46851c0e6ef2138892037ec620d67d0688e593cb99169` |

Electron's staged JS/WASM/data have these same hashes. The normal Web build
already sanitizes unreachable Node branches in generated JavaScript through
`webOnlyWasmLoader()`; that pre-existing transform remains unchanged. Its JS
hash therefore differs, while its WASM/data hashes match. Separate normal Web
DRC and STEP E2E tests pass in threaded and serial modes. **No host-specific
WASM compilation or additional artifact variant is needed.**

## Verification record

Commands are run from the worktree root unless stated otherwise. Environment
variables in the host commands are build inputs, not runtime substitutes for
staging the correct artifacts.

| Check | Result |
| --- | --- |
| `scripts\build-windows.bat quick --variant threaded -j 6` | Passed; includes NODEFS. |
| `scripts\build-windows.bat quick --variant serial -j 6` | Passed; no NODEFS link. |
| `pnpm --filter @orca/profile-resources build` and `pnpm stage:assets` | Passed; 67 profile packages and both artifact variants staged. |
| `pnpm exec node packages/slicer-wasm/harness/nodefs-bridge-smoke.mjs` | Passed; comprehensive bridge contract with actual native files, including asynchronous cancellation and superseded-result checks. |
| `scripts\build-windows.bat smoke --variant serial` | Passed; slice, comprehensive bridge, DRC and valid/malformed STEP checks. |
| `pnpm test` and `pnpm typecheck` | Final handoff rerun passed: 1,326 unit tests and all workspace typechecks. |
| Electron threaded DRC/STEP E2E | Both passed. |
| Electron native-file/lifecycle E2E | Passed; native byte equality, GPU preview, paged source lines, generation replacement, 3MF round trip, reload, utility/renderer crash, and normal quit cleanup. |
| Web threaded E2E | Three passed: unmodified shared artifacts, normal DRC, normal STEP. |
| Web serial E2E | Two passed: normal DRC and STEP without isolation. |
| Electron serial E2E | Passed; real import/slice/preview/export and reload/quit retain MEMFS with an empty native session directory. |

The threaded lifecycle test uses a native temp root containing spaces and
Chinese characters. The first G-code was 287,069 bytes; after changing the
object's layer height to 0.3, the replacement was 218,825 bytes. A 9,760-byte 3MF
saved and reopened with that object override intact. All four session
directories were removed. After deliberately crashing the renderer, Playwright
cannot reuse its disconnected Page; a fresh app provides the final live-runtime
quit check. Renderer-crash cleanup is checked before that relaunch.

Electron build and focused checks:

```powershell
$env:VITE_USE_MOCK = '0'
$env:VITE_E2E = '1'
$env:VITE_SCOPED_CONFIGURATION_GATE = '1'
$env:VITE_SCOPED_CONFIGURATION_GATE_VARIANT = 'threaded'
pnpm --filter @orca/desktop exec electron-vite build
$env:ORCA_E2E_REAL = '1'
$env:ORCA_E2E_NODEFS_EXPECT_VARIANT = 'threaded'
pnpm --filter @orca/desktop exec playwright test e2e/nodefs-runtime.e2e.ts
pnpm --filter @orca/desktop exec playwright test e2e/app.e2e.ts --grep 'real DRC flow|real STEP flow'
```

For the focused serial check, rebuild with
`VITE_SCOPED_CONFIGURATION_GATE_VARIANT=serial` and run the native-file test with
`ORCA_E2E_NODEFS_EXPECT_VARIANT=serial`. The latter only asserts the selected
runtime; it does not select an artifact.

Web compatibility checks use a fresh preview server:

```powershell
$env:CI = 'true'
$env:VITE_USE_MOCK = '0'
Remove-Item Env:ORCA_WEB_NO_ISOLATION -ErrorAction SilentlyContinue
pnpm --filter @orca/desktop exec playwright test --config ../../apps/web/playwright.config.ts e2e/nodefs-compatibility.e2e.ts e2e/step-import.e2e.ts e2e/web.e2e.ts --grep 'unchanged shared|real Web flow|real Web STEP'
$env:ORCA_WEB_NO_ISOLATION = '1'
pnpm --filter @orca/desktop exec playwright test --config ../../apps/web/playwright.config.ts e2e/step-import.e2e.ts e2e/web.e2e.ts --grep 'real Web flow|real Web STEP'
```

## Performance scope

The user explicitly requested skipping performance tests. Performance is not an
acceptance gate for this validation. Preliminary filesystem-only measurements
had already run before that request; their local logs are retained, but no
latency, throughput or memory-regression conclusion is used here.

## Limits

- This is a Windows feasibility check for existing temporary-file workflows,
  not full release qualification. macOS/Linux, packaged installers and disk-full
  recovery are not qualified by these results.
- Abrupt termination of Electron main or the machine cannot run cleanup. No
  startup orphan-directory scavenger was introduced. Cleanup failures are
  logged after bounded filesystem retries.
- NODEFS avoids keeping an additional MEMFS backing copy of files under
  `/tmp`. Existing model upload, preview transport and full-buffer export APIs
  retain their copies; this change is not an end-to-end zero-copy conversion.
- Native path availability does not change preview caching or authorize
  external mutation of indexed G-code.
