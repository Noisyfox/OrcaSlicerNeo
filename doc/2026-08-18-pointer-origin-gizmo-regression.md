# Pointer-origin Gizmo Regression Fix

Date: 2026-08-18
Status: Implemented
Scope: Scene-owned viewport pointer arbitration.

## Problem

`@react-three/drei` `DragControls` waits for movement to cross its drag
threshold before it invokes `onDragStart`. Previously the controller decided
whether a body drag was allowed from the live gizmo-hover state. A user could
press a model body and move to a gizmo handle before that threshold callback,
allowing the gizmo path to take the gesture.

## Resolution

The viewport now latches the pointer-down hit as either `gizmo` or
`non-gizmo`. The latch survives hover changes until pointer release,
cancellation, or gesture completion. A gizmo may start only from a
`gizmo`-origin press, while a non-gizmo-origin press keeps body dragging
enabled even after the pointer enters a grabber.

## Verification

- Controller unit coverage simulates a body press that reaches a grabber
  before the drag threshold and verifies that the body gesture, not the gizmo,
  owns it.
- Desktop unit tests and type checking were run after the change.
