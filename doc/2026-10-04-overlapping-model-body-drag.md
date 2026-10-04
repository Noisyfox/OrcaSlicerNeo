# Overlapping Model Body Drag

Date: 2026-10-04
Status: Implemented and verified
Scope: Shared desktop/Web viewport pointer dispatch.

## Accepted behavior

A body press selects and arms only the frontmost visible model or Prime Tower
surface. R3F event filtering removes subsequent body intersections before
bubbling to DragControls, retaining gizmo intersections and build-plate
occlusion. The body handler still receives the press before its DragControls
ancestor, preserving immediate selection and the first movement threshold.
Only the wrapper accepted by the scene controller may update or finish a body
drag. Releasing the mouse retains the final displayed translation and commits
one Move transaction. Existing multi-selection and gizmo priority remain valid.

## Cause

Native stopImmediatePropagation does not stop R3F's intersection dispatch.
Overlapping bodies armed multiple Drei DragControls, whose drag scratch vectors
are shared across wrappers. The pending hit could be overwritten by a rear
body, and rejected wrappers could still update or end the accepted body drag.

## Compatibility

The change belongs to the shared renderer; no runtime or WASM ABI changes are
required. It adds one linear filter over existing intersections and one boolean
per rendered interactive volume. Mobile support remains deferred under the
shared application architecture.

## Verification

- `pnpm --filter @orca/slicer-app exec vitest run src/components/workspace/viewport/buildPlatePointerOcclusion.test.ts src/components/workspace/viewport/SceneInteractionController.test.ts`: 69 tests passed.
- `pnpm test`: all 153 files / 1,451 tests passed.
- `pnpm typecheck`: all workspace packages passed, including after the final E2E edit.
- `pnpm --filter @orca/desktop exec electron-vite build --mode e2e`: passed.
- `pnpm --filter @orca/desktop exec playwright test e2e/app.e2e.ts --grep 'overlapping bodies|unselected body keeps|gizmo priority, multi-instance'`: all three passed with the final fix. This covers release stability, Undo, immediate body selection, multi-instance moves, gizmo priority, and transform synchronization.
- Baseline comparison: with the original ModelMesh and Viewport restored and the E2E build regenerated, two bodies offset by 5 mm reproduced a release jump from X=18.526545735212352 to X=23.526545735212352. The new release-stability assertion failed on that baseline and passed after restoring/rebuilding the fix.
- Initial E2E attempt failed because the test expected two renderer volumes; the mock fixture contains four (two volumes per instance). The fixture assertion was corrected before the baseline comparison and final successful run.
- `git diff --check`: passed. Commands above match workspace package scripts and the testing guideline's focused Electron execution route.
- Real Web E2E and WASM builds were intentionally skipped: no host adapter, deployment, runtime, or native bridge code changed.
