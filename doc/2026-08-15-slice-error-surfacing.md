# Slice error surfacing: SlicingErrors messages + no double-wrap

Date: 2026-08-15

## The bug

Slicing a model whose first layer has no extrusions showed only
`Error Error: Errors` in the app status bar — with nothing to say what
actually failed, and no console output to dig into.

Root cause chain (three independent defects stacking):

1. **libslic3r** — `Print::process()` aggregates per-object failures as
   `SlicingErrors` (`GCode.cpp:2250`), whose `what()` is hardcoded to the
   category `"Errors"`; the real per-object messages live in its `errors_`
   vector (`Exception.hpp:40-47`). `Print::validate()` would have returned a
   specific `StringObjectException` message, so the bare category also proves
   the failure came from `process()`, not validation.
2. **bridge** — the `orc_slice` catch returned `e.what()` only, discarding the
   `errors_` messages: the renderer could never see anything beyond "Errors".
3. **renderer** — `Toolbar.slice()` wrapped `r.error` in `new Error(...)`, and
   the status bar already prefixes "Error" — `"Error" + "Error: Errors"`.

## What changed

- `packages/slicer-wasm/src/bridge.cpp` — new `error_json_from_exception()`:
  `dynamic_cast` to `SlicingErrors` and join the per-object messages from
  `errors_` (newline-separated); everything else falls back to `e.what()`.
  Used by `orc_slice`'s catch.
- `apps/desktop/src/renderer/src/slicer/errors.ts` — new `errorText(err)`
  helper: `err instanceof Error ? err.message : String(err)`. Standalone
  module (no worker import) so vitest can run it in node env.
- `apps/desktop/src/renderer/src/components/toolbar/Toolbar.tsx` — a failed
  slice is *not* a thrown error: set the bridge's plain message directly
  (`r.error`), no `Error()` round trip. Open/export catches use `errorText`.
  Every failure path also `console.error`s now. Starting a new slice clears
  the previous error (`setError(null)`), so the status bar never shows a
  stale failure while the next slice runs.

## The user's model

The reported model ("tolerance test all.STL") throws the classic
"empty first layer" case: features start above the first layer plane (or are
too thin for it). The status bar now shows the actionable message:

> One object has an empty first layer and can't be printed. Please Cut the
> bottom or enable supports.

## Verification

- `packages/slicer-wasm/harness/bridge-smoke.mjs` section 10 — new
  `floating-box.stl` fixture (20×20 box, bottom at z=0.3, above the 0.2 first
  layer, no supports → deterministic "empty first layer"). Asserts the slice
  error is the real message, not "Errors". 49 PASS / 0 FAIL.
- `apps/desktop/src/renderer/src/slicer/errors.test.ts` — 3 vitest cases for
  `errorText` (unwrap Error, pass through strings, stringify other).
- `apps/desktop/e2e/slice-error.e2e.ts` — real-module-only e2e (skipped in
  mock builds): loads `floating-box.stl`, slices, asserts the status bar is
  `Error` with the real message and Export stays gated; then re-slices and
  asserts the error clears while the new slice runs and returns on the
  re-failure. The cleared state lasts only ~12 ms (the second slice
  short-circuits the expensive parts — same model + config — while
  `collect_layers_to_print` still runs and re-throws immediately), so the
  spec observes it with an in-page MutationObserver, not polling. Wired into
  both `test:e2e` (skipped) and `test:e2e:real` (`ORCA_E2E_REAL=1`, set by
  CI).
- Manual repro with the user's model → real message in status bar +
  `console.error`; cube happy path → "Sliced", no destructive span.
- `pnpm run typecheck` clean; vitest 4 files / 9 tests pass.
