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

## Real-project CI qualification

The real-module CI run initially failed when selecting the adjacent plate's
Prime Tower. The test sampled at fixed Z=9 using unrotated offsets; with
frontmost-only event dispatch, these low rays could no longer select through
an intervening model. The actual tower top projected outside the default
988-pixel canvas (X=1034). The regression now establishes a 1600x900 viewport
and searches the rendered world bounds at the tower's top height, checking
canvas containment before issuing real mouse clicks. Native move, boundary
clamping, history, slicing, and export assertions remain in the same journey.

The CI failure was reproduced locally with the exact threaded and serial
artifacts downloaded from run `37185817903`, a fresh real renderer build
(`VITE_USE_MOCK=0 VITE_E2E=1`), explicit public-asset copying, and the verified
temporary `big-proj.3mf` fixture copy. Staged WASM SHA-256 values were checked
against the downloaded artifacts. The unchanged test failed at the same
non-current-tower selection assertion. A top-surface-only attempt at the old
viewport also failed; bounds/ray diagnostics showed the surface was outside
the canvas. With both the explicit viewport and top-surface selection in place,
`pnpm --filter @orca/desktop exec playwright test e2e/prime-tower-project.e2e.ts`
passed the complete real-module journey in 1.6 minutes. The source fixture's
44,473,498-byte length and SHA-256 remained unchanged. Desktop typechecking
and `git diff --check` passed. No native source or WASM build changes were needed.
