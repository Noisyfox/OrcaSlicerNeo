# Viewport box selection (Shift + drag)

**Date:** 2026-08-22

**Status:** Implemented

## Goal

Hold **Shift** and left-drag anywhere in the 3D viewport to draw a screen-space
selection rectangle (marquee). On release, every instance whose projected
bounds intersect the rectangle is selected. **Shift+Ctrl/Cmd+drag** unions the
box result into the current selection instead of replacing it.

This mirrors OrcaSlicer's native `GLCanvas3D` box-selection gesture: Shift turns
the left-button drag from orbit / body-move into a marquee, and the selection is
instance-based (`objectIdx:instanceIdx`), exactly like pointer clicks.

## Gesture arbitration

The viewport's existing DOM capture handler (`Viewport` container
`onPointerDownCapture`) already rechecks the TransformControls picker before
anything else (`resolveGizmoPointerDown`). Box selection is decided in that same
handler, after gizmo arbitration:

1. Left button + Shift, and the press does **not** grab a gizmo handle, and the
   event target is the canvas (overlay DOM like the toolbar/scrubber is never
   hijacked) → the viewport claims the whole gesture and
   `stopImmediatePropagation()`s the press, so OrbitControls never starts
   orbiting and DragControls never starts a body drag.
2. The gesture is tracked with window-level `pointermove`/`pointerup`/
   `pointercancel` listeners (capture phase), so the marquee keeps tracking even
   when the pointer leaves the canvas.
3. Once movement exceeds 4 px, `SceneInteractionController.beginBoxSelect`
   arms the marquee (`pointerOwner = 'box'`), which disables R3F raycasting and
   body dragging for the rest of the gesture.
4. A Shift press that never reaches the threshold is a **click**, not a marquee:
   the viewport raycasts the release point itself and mirrors the normal click
   path (`selectFromClick` on a model body, `clearSelection` on empty space), so
   Shift+click behavior is unchanged from today.

`pointerOwner = 'box'` is a new member of the existing `PointerOwner` union, so
the existing raycasting gate (`isViewportRaycastingEnabled`) and the body-drag
guard (`bodyDragEnabled`) keep working without special cases.

## Selection math

`SceneInteractionController` owns the marquee lifecycle and the final selection:

- `beginBoxSelect(start, additive)` / `updateBoxSelect(current)` /
  `endBoxSelect()` / `cancelBoxSelect()` manage an internal
  `{ start, current, additive }` state and expose it as a normalized
  `boxSelectionRect` (`{ x, y, width, height }` in viewport CSS pixels) for the
  marquee overlay.
- A projector registered by the viewport (`registerBoxSelectProjector`) maps a
  world-space point to viewport CSS pixels via the live camera; corners behind
  the camera are skipped.
- On release the controller projects the world AABB of every volume, unions the
  projected rects per instance, and selects complete instances whose union rect
  intersects the marquee (`boxSelectionMath.rectsOverlap`, edge-touching
  counts). Replace-mode clears anything outside the marquee; additive mode only
  adds.

The math helpers (`normalizeRect`, `rectsOverlap`, `unionRects`) are pure and
unit-tested in `boxSelectionMath.ts`.

## UI

The marquee is a plain absolutely-positioned overlay div
(`data-testid="box-select-marquee"`) rendered by the viewport container
(outside the R3F tree), subscribed to the controller like the gizmo toolbar. It
is `pointer-events-none`, so it never steals a press.

## Tests

- `boxSelectionMath` unit tests: rect normalization (negative drags), overlap
  including edge-touching, union.
- `Selection` unit tests: the new `replaceIds` / `addIds` primitives.
- controller unit tests: claiming/releasing the pointer, marquee rect updates,
  replace vs additive box selection against a deterministic projector, no-op
  without a projector, cancellation on `clearSelection`/model reset.
- desktop e2e (mock): Shift+drag across both fixture cubes selects both
  instances; Shift+drag over empty space clears; the marquee element appears
  during the drag.

## Deferred

- A crosshair cursor while Shift is held (native OrcaSlicer shows one); the
  marquee itself is the current affordance.
- A minimum-area marquee (single-pixel-width "line" selections are currently
  allowed once the 4 px arm threshold is crossed).
- Web-host e2e coverage of the gesture (desktop mock covers the shared code
  path; the web host shares the same `slicer-app` viewport).

## Decision: why not the drei `Select` component

`@react-three/drei` ships a `Select` component with a built-in `box` mode
(Shift+drag marquee backed by three-stdlib's `SelectionBox`). It was evaluated
against the installed version (drei 10.7.8) and deliberately **not** adopted
for the marquee, because the component's constraints conflict with this app's
tested interaction model:

- Box mode requires `multiple`, which also rewrites **click** semantics:
  plain-click toggles the clicked object off/on and collapses multi-selections,
  whereas the app keeps the complete instance selection on a plain click
  (controller `selectFromClick`, covered by unit + e2e tests).
- The Shift+drag listener is **document-wide** with no target guard, so a
  Shift+drag over the toolbar, layer scrubber, or a gizmo handle would draw a
  marquee. The installed version has no `enabled` prop to gate it.
- It owns its own `Object3D[]` selection state with no bridge to the app's
  instance-based `Selection` (a hit must expand to the complete
  `objectIdx:instanceIdx`, the way native OrcaSlicer selects).
- Its box result replaces the whole selection on every move — no additive
  Shift+Ctrl/Cmd box, and no live "keep the pre-box selection" preview.
- `SelectionBox` hit-tests by bounding-sphere **center** inside a camera-space
  frustum: a marquee over the half of an object whose center lies outside the
  box misses it, unlike native box select (screen-space bounds intersection).
  It also collects the bed plate and toolpath lines, which then need filtering.

The gesture plumbing in this design (DOM capture guard, 4 px arm threshold,
Shift+click fallback, gizmo priority) is exactly the part drei cannot express;
the selection math (projected world-AABB per instance, rect intersection) is
kept so partial overlaps select, matching native OrcaSlicer. Re-using drei's
`Select` wholesale would require accepting the click-semantics changes above.
