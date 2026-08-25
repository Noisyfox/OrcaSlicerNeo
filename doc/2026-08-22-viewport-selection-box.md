# Viewport selection bounding box

**Date:** 2026-08-22

**Status:** Implemented

## Goal

Whenever the 3D viewport has a non-empty selection, render a wireframe
bounding box around it, matching OrcaSlicer's native selection rendering.
Multi-selection renders **one** box around the aggregate bounds of every
selected instance, never per-instance boxes.

## Native reference

The look is taken from the pinned upstream source
(`packages/slicer-wasm/cpp/src/slic3r/GUI/Selection.cpp`,
`Selection::render` / `Selection::render_bounding_box`):

- The box is the union world AABB of all selected volumes
  (`Selection::get_bounding_box_in_current_reference_system`), rendered as a
  single `GL_LINES` model. That world AABB is computed the way the native
  `Selection::get_bounding_box_in_reference_system` (World reference system)
  does: **every mesh vertex is transformed into world space** by the
  instance·volume matrix and the axis-aligned min/max is accumulated. It does
  **not** transform the 8 corners of the local bounding box — that would
  over-approximate a rotated model and leave the bracket floating around it.
  The result always stays axis-aligned with the world axes (it never rotates
  with the model) and snaps to the model's true extremes, so it works for any
  arbitrary Euler rotation.
- It is drawn **white** in the 3D view (yellow in the assemble view).
- Each of the 8 corners has three short segments running inward along X/Y/Z;
  a segment length is 20 % of the box size along that axis
  (`Vec3f size = 0.2f * box.size()`).
- Lines are solid (`gap_size = 0.0`), screen-space ~1.5 px wide (the
  `dashed_thick_lines` geometry shader, `width = 1.5`), anti-aliased.
- Depth test stays enabled, so brackets behind the model are occluded exactly
  like the model surface; the selection renders right after the opaque objects
  and before the gizmos.

## Implementation

`packages/slicer-app/src/components/workspace/viewport/`:

- `selectionBoundsBoxGeometry.ts` — pure helper
  `selectionBoundsBoxPositions(bounds)` that turns a `THREE.Box3` into the
  24 line segments (48 vertices) of the native bracket pattern. Unit-tested.
- `SelectionBoundsBox.tsx` — viewport component:
  - reads the existing aggregate `SceneInteractionController.selectionBounds()`
    (the union of all selected volumes' **tight** world AABBs over the actual
    transformed vertices, see `GLVolume.getWorldBounds()`);
  - renders the segments as a plain `THREE.LineSegments` + white
    `LineBasicMaterial` (WebGL core line width is 1 px — a close match for the
    native 1.5 px geometry-shader lines);
  - keeps the default depth test so back brackets occlude against the model;
  - disables raycasting (`raycast={() => undefined}`) so the box never
    participates in picking/context-menu hits;
  - subscribes through `useSceneInteractionVersion()`, so the box follows
    selection changes **and** live transform drags (every controller `emit`
    bumps the version);
  - renders only while **no gizmo is open** — arming move/rotate/scale from
    the toolbar hides the box (the gizmo takes over the selection visual),
    and closing the gizmo restores it. This is a deliberate deviation from
    the native `!m_gizmos.is_running()` gate, which hides the box only while
    a gizmo drag is in progress. Body drags keep the box visible and
    following.
- `Scene.tsx` mounts `<SelectionBoundsBox />` right after the volume meshes,
  mirroring the native render order (opaque models → selection box → gizmos).

## Tests

- `selectionBoundsBox.test.ts`: segment count, corner positions, bracket
  lengths for a single box and for an aggregate (multi-selection) box.
- `SceneInteractionController.test.ts`: the selection bounds snap to the
  actual transformed vertices of an arbitrarily-rotated model (a 45° X rotation
  of a slanted tetrahedron must top out at ½√2, not the loose local-bbox √2).
- Desktop e2e (`apps/desktop/e2e/app.e2e.ts`, mock mode): the box appears
  after a click selection, becomes the single union box after Shift+drag
  multi-selection, collapses back to one instance's box after replace/clear,
  and disappears when the selection empties. The mock-only hook
  `selectionBoxWorldSegments()` exposes the rendered segments' min/max and
  segment count to Playwright.
