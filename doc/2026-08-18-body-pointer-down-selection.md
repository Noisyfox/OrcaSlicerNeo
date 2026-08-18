# Body Pointer-down Selection

Date: 2026-08-18
Status: Implemented
Scope: Viewport body selection and drag initiation.

## Change

A primary-button press on a model body now selects its complete instance
immediately, before `DragControls` reaches its movement threshold. The same
press can therefore continue directly into a body drag even when the body was
previously unselected.

The body-drag wrapper remains enabled while the selection is empty so it can
receive that initial press. Pointer-down preparation remains blocked for a
gizmo-origin press, preserving TransformControls grabber priority. Ctrl/Cmd
selection is applied once on pointer-down; the corresponding click is consumed
to avoid toggling it a second time.

## Verification

- Controller unit coverage verifies an unselected body becomes selected at
  pointer-down and that the same gesture can acquire body-drag ownership.
- Desktop unit tests and type checking are run with this change.
