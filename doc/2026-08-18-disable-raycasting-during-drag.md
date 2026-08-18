# Disable Viewport Raycasting During Dragging

Date: 2026-08-18
Status: Implemented
Scope: React Three Fiber viewport interaction performance.

## Problem

React Three Fiber performs a full scene raycast before it can dispatch each
pointer event. While orbiting over a high-triangle model, that repeated
intersection work made frame rate depend on whether the cursor happened to be
over the model.

## Resolution

The viewport event manager is disabled while OrbitControls has an active mouse
gesture. This skips raycasting at the event-manager boundary, before Three.js
tests model triangles. Body and gizmo drags also keep that event layer disabled
through the scene interaction controller's active drag owner. Raycasting is
restored on release or cancellation, so ordinary hover and selection behavior
continues when the pointer is idle.

A body press also stops the native pointer event before OrbitControls receives
it. `DragControls` intentionally waits for a movement threshold, but camera
controls must not rotate the scene during that threshold window. Gizmo-origin
presses retain their existing priority and still reach TransformControls.

## Verification

- Unit coverage verifies the dynamic event-manager gate.
- Desktop unit tests and TypeScript checking cover the viewport integration.
