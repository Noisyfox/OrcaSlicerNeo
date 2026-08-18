# Add Model and Clear Scene

Date: 2026-08-18
Status: Implemented
Scope: desktop toolbar model-file actions

## Decision

Replace the ambiguous **Open** toolbar action with **Add Model**. Selecting an
STL or 3MF appends its objects to the current WASM `Model`; it does not replace
objects already on the plate. A separate **Clear Scene** control resets both
the WASM model and the renderer collection.

## Bridge and UI contract

- `orc_add_model(bytes, extension)` stages and parses a file into a temporary
  `Model`, prepares non-project objects using the existing centering/on-bed
  behaviour, then clones its objects into the current scene.
- `orc_clear_model()` resets the model and clears the associated `Print`, so a
  stale G-code result cannot be exported after a clear.
- Every successful add or clear advances the renderer's model revision. This
  causes the viewport to fetch the complete, current collection; a boolean
  alone would not re-run the loader when adding a second model.
- A completed move commits a snapshot of renderer-side transforms to WASM at
  mouse release (or after a panel action). Add Model waits only for a pending
  settled commit, so its reload retains every existing model position without
  delaying persistence until another action.
- The synthetic click emitted after either a body or move-gizmo drag is
  consumed. Releasing a group move over one selected model therefore retains
  the complete selection.
- Adding or clearing invalidates the slice result and selection. Cancelling a
  file dialog or a failed import leaves the scene and its current slice state
  unchanged.

## Verification

- Client/mock contract tests cover additive import and clear.
- Desktop typecheck and unit tests cover the toolbar-facing state revision.
