# History contract cleanup

Date: 2026-09-20
Status: Delivered

## Accepted behavior

The application and Worker use the current timestamped history and SceneDelta
contract. Remove unused internal compatibility branches and the superseded
history engine; retain Orca project-file compatibility. Plate membership comes
from the authoritative session, not a fallback that exposes every plate.

Mock restore results must include the same authoritative plate session as the
native bridge. Without it, the renderer rejects the restore after the mock has
already moved its cursor, leaving the old scene visible. The shared toolbar e2e
must continue to prove that Undo of the first import clears the scene.

History request revisions fence asynchronous restores only. GL mesh publication
uses the settings model revision, which subsequent additive imports wait for.
Mixing these counters caused imports after Undo/Redo to be rejected as stale.

Rollback snapshots continue to retain only validated result availability;
restore never reloads Preview. Users enter Preview to load eligible results.

The headless model types live in `ModelState.hpp`. The superseded
`ProjectHistory` implementation and its build target are removed. Native mesh
owners are the sole immutable mesh representation; missing owners fail restore.
The unused optional byte-copy release phase and its diagnostic counter are
removed. Mesh ownership, stable IDs, and budget eviction remain covered through
`TimestampedHistory` and the native model adapter.

The current restore protocol carries SceneDelta and an authoritative session.
Direct Move/Prime Tower/Add Plate restore receipts, their unused renderer
projection helpers, and receipt-only diagnostics/tests are removed. The client
rejects a restore that requires a session but does not supply a valid one.

Plate membership is required in the internal session contract. Mock reads and
mutations publish complete membership consistently, including per-plate instance
IDs. Preview hides model volumes until a session exists. Slice/send reject a
plate without members. Test fixtures now provide the current contract rather
than depending on partial legacy snapshots.

Multi-plate saving remains native and lossless. The obsolete flattened-project
flag, confirmation callback, menu field, and dialog are removed. Internal camel
case configuration-status and G-code length aliases, geometry-atlas aliases,
and runtime-method existence guards for required APIs are removed. Orca file
and preset compatibility handling is unchanged.

## Validation

Restore fix: `pnpm --filter @orca/slicer-wasm test` (160 tests),
`pnpm --filter @orca/slicer-app test` (597 tests), both package typechecks,
and `git diff --check` passed. After the mock Electron e2e build,
`pnpm --filter @orca/desktop exec playwright test e2e/app.e2e.ts -g 'shared history toolbar|undoes the first Cube'`
passed both tests, including further imports and directional menu jumps after
Undo/Redo.

Cleanup validation:

- `pnpm test`: 897 tests passed across 107 files. Removed tests exercised deleted
  implementations; current SceneDelta, mesh ownership, budget eviction, stable
  IDs, and missing/invalid membership remain covered.
- `pnpm typecheck`: all workspace packages passed.
- Final focused rerun: `pnpm --filter @orca/slicer-app exec vitest run src/components/workspace/Workspace.test.tsx src/history/restoreCoordinator.test.ts`
  passed 22 tests; `pnpm --filter @orca/slicer-wasm test` passed 159 tests.
- `scripts\build-windows.bat quick -j 8`: threaded and serial passed.
- In the activated emsdk environment,
  `emmake ninja -C packages/slicer-wasm/.work/threaded/build timestamped_history_core_test history_mesh_capture_test -j 8`
  and the serial `timestamped_history_core_test` target passed. Running the
  corresponding `.cjs` launchers with Node passed all three native tests.
- `node packages/slicer-wasm/harness/bridge-smoke.mjs packages/slicer-wasm/out/<variant>/orca_slice.js packages/slicer-wasm/fixtures/cube.stl`:
  passed for `threaded` and `serial`.
- `node packages/slicer-wasm/harness/history-smoke.mjs packages/slicer-wasm/out/threaded/orca_slice.js`
  and `history-plate-runtime-smoke.mjs` with the same module passed. The latter
  now checks the accepted all-plate invalidation policy after Undo/Redo.
- With `VITE_USE_MOCK=1`, `pnpm --filter @orca/desktop exec electron-vite build --mode e2e`
  passed. `pnpm --filter @orca/desktop exec playwright test e2e/app.e2e.ts -g 'full v1 flow|shared history toolbar|undoes the first Cube'`
  passed all three cases.
- The two edited real-project profile tests were parsed/listed with Playwright
  `--list`. Their obsolete receipt-counter assertions were removed; model
  restoration, SceneDelta projection, full-reload exclusion, and timing checks
  remain. The expensive real-project profile and full dual-host release matrix
  were intentionally not rerun; no new performance measurement is claimed.
- `git diff --check` passed. The pre-existing submodule worktree modifications
  were excluded from both commits.
