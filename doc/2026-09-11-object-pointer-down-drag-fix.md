# Object Pointer-down Drag Fix

Date: 2026-09-11
Status: Verified
Scope: Restore the existing viewport contract that a primary press on an
unselected ordinary model instance selects it synchronously and may continue
as the same body-drag gesture. Ordinary models and Prime Tower share the same
`DragControls` body-gesture path; only their renderers and commit adapters
differ. The pinned WASM submodule is out of scope.

## Accepted behavior

- A press-and-release on an unselected ordinary model selects its complete
  instance without creating transform history.
- A press followed by a same-event-turn movement past the body-drag threshold
  moves that newly selected instance in the same gesture; the first movement
  delta is retained without waiting for a React selection render.
- Existing selected-object, multi-selection, lock, gizmo-priority,
  cancellation, and one-history-entry-on-success behavior remains unchanged.

## Verification

The controller exposes the body selection-history state as `pending`,
`dragging`, or `idle`. ObjectList delays its context-only `Selection` history
record while the body press is pending. A confirmed body drag discards that
deferred record because the `Move` transaction captures the same selection in
its before/after context. A click releases the pointer to `idle`, publishes the
controller update, and records the deferred selection context normally.

This prevents a context-only history mutation from acquiring the project lease
between `DragControls` pointer-down and its threshold-crossing first move. It
does not add a native/window input path or a Prime Tower special case.

The Electron mock-host regression sends native `mouseDown` and threshold-
crossing `mouseMove` in one Electron main-process task, checks immediate body
ownership and a changed pivot, then verifies the single Move history entry after
release. The controller regression covers the matching pending → dragging →
idle state transitions.
