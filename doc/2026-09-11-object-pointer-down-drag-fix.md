# Object Pointer-down Drag Fix

Date: 2026-09-11
Status: Verified — current implementation already satisfies the contract
Scope: Restore the existing viewport contract that a primary press on an
unselected ordinary model instance selects it synchronously and may continue
as the same body-drag gesture. Prime Tower behavior and the pinned WASM
submodule are out of scope.

## Accepted behavior

- A press-and-release on an unselected ordinary model selects its complete
  instance without creating transform history.
- A press followed by movement past the body-drag threshold moves that newly
  selected instance in the same gesture; the first movement delta is retained.
- Existing selected-object, multi-selection, lock, gizmo-priority, Prime Tower,
  cancellation, and one-history-entry-on-success behavior remains unchanged.

## Verification

The controller regression test exercises selection at pointer-down followed by
the first threshold-crossing body-drag delta, then asserts the selected
instance transform and one commit. The Electron mock-host regression begins
from an explicitly empty selection, sends `mouse.down` on an ordinary model,
crosses the drag threshold before any click can be dispatched, and proves that
the body owner and pivot update on that first segment. It also proves that
release changes the Undo label once to `Move`.

The current code performs ordinary-model selection in
`GLVolumeMesh.onPointerDown`, before the `DragControls` threshold callback.
`SceneInteractionController.prepareBodyDragFromPointerDown` synchronously
expands the selected instance, while `tryBeginBodyDrag` owns the later
threshold crossing and begins exactly one history gesture. Prime Tower uses the
same mesh wrapper but bypasses model-transform history for its scene-only move.
No production change was required: the precise real-host event sequence passes
on the current commit. The original report needs a reproducer with any missing
precondition (for example a particular model, active gizmo overlap, or project
state) before a behavior change would be justified.
