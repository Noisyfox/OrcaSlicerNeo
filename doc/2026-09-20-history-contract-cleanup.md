# History contract cleanup

Date: 2026-09-20
Status: In progress

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

## Validation

Restore fix: `pnpm --filter @orca/slicer-wasm test` (160 tests),
`pnpm --filter @orca/slicer-app test` (597 tests), both package typechecks,
and `git diff --check` passed. After the mock Electron e2e build,
`pnpm --filter @orca/desktop exec playwright test e2e/app.e2e.ts -g 'shared history toolbar|undoes the first Cube'`
passed both tests, including further imports and directional menu jumps after
Undo/Redo. Cleanup validation will be recorded here on completion.
