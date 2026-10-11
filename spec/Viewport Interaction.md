# Viewport Interaction

**Updated:** 2026-10-11
**Status:** Delivered behavior
**Scope:** Shared Electron/Web model selection, transforms, camera and rendering.

## Coordinates and rendering

The scene uses slicer coordinates: X/Y on the plate and Z up. The shared entry
imports `threeZUp.ts` before constructing Three.js objects. Instance and volume
rotations use Euler ZYX, matching native `Rz · Ry · Rx`. An explicit affine
matrix is authoritative when present, including shear from nonuniform world
scaling; clean transforms use translation, rotation, scale and mirror.

The viewport renders on demand. Camera motion, model or selection changes,
imperative transforms and asynchronous resource publication invalidate it;
an idle scene does not run a continuous render loop. Ordinary and MMU-painted
model materials and plate thumbnails use per-face shading while retaining
indexed geometry, shared buffers and BVH picking. Auxiliary-volume materials
follow [Object List and Object Parts](ObjectList-and-Parts.md).

Initial framing uses the selected printer's printable-area bounds, looking
from the front at a 45-degree elevation with X horizontal. Orbit uses Z up;
middle/right drag pans. The orientation gizmo returns to axis-aligned views.
The current plate's geometry, grid and artwork are specified in
[Printer Bed Display](Printer%20Bed%20Display.md).

## Selection and pointer ownership

One scene-owned `SceneInteractionController` owns selection, the active gizmo,
and each gesture. Sidebar and toolbar controls project that state. Model
volumes have composite renderer identities; native stable IDs govern mutation
and history restoration. The complete object/instance/part selection and list
highlighting rules live in [Object List and Object Parts](ObjectList-and-Parts.md).

- A normal body press selects the complete instance and can immediately
  continue into a drag. Pressing an already selected member preserves a group.
- Ctrl/Cmd-click toggles complete instances; Alt-click targets a part within
  one instance. Empty-space clicks clear ordinary selection, including a tower.
- Only the frontmost eligible model or Prime Tower receives a body press.
  Intersections behind the build plate are occluded; decorative bed geometry
  and overlays do not become model targets.
- Gizmo grabbers have priority. Pointer-down captures the press origin for
  the complete gesture; later hover changes cannot steal a body press.
- Only the accepted drag wrapper may update or finish a gesture. Cancellation,
  release and selection replacement release ownership and restore camera input.
  Raycasting unrelated scene bodies is suspended during active manipulation.

Shift-left-drag draws a screen-space marquee after a 4 CSS-pixel threshold.
Gizmo handles retain priority, and toolbar/overlay DOM is excluded. Release
selects complete instances whose projected bounds intersect the rectangle,
including edge touches. Shift+Ctrl/Cmd unions the result with the previous
selection. A sub-threshold gesture retains click behavior; cancellation
discards the marquee. Pointer tracking continues outside the canvas.

The selected set has one aggregate world-axis-aligned outline, computed from
actual transformed mesh vertices rather than transformed local-box corners.
Selection changes invalidate the outline; view helpers do not intercept input.

### Pointer and display constraints

Body dragging is locked to the world XY plane at the current height
(`axisLock="z"`). Only the Move panel or Z-axis grabber changes height.
Alt-click explicitly narrows selection to the hit part even when its parent
is selected; Alt+Ctrl/Cmd toggles parts within the same instance.

Marquee selection is canvas-scoped and uses projected bounds intersection,
including partial overlap; it must not use a sphere-centre-only test or drei
Select's document-wide ownership. Behind-camera corners are excluded. The
marquee overlay has `pointer-events: none`. A line-shaped rectangle remains
valid after the drag threshold; no minimum-area rule or crosshair is required.

The selection outline is visible only while no gizmo is armed; body dragging
keeps it visible. Arming any gizmo hides it immediately, before dragging. This
is a deliberate difference from native Orca's running-drag-only suppression.
Its white corner brackets comprise eight corners with three inward segments
each (20% of the corresponding world-bounds dimension, 24 segments / 48
vertices), using 1px `LineBasicMaterial`. It is depth-tested, rendered after
opaque objects and before gizmos, and excluded from raycasting.

The bottom-left orientation helper is an axes-style `GizmoViewport`, not a
viewcube: X is `#ff2060`, Y `#20df80`, Z `#2080ff`. Axis presses tween the camera
and restore Z-up. Its HUD owns pointer priority and stops propagation so a
camera action cannot deselect or transform a model.

Imperative Three.js mutations and unchanged JSX do not automatically schedule
a frame. Draw-range, transform and resource changes must explicitly invalidate.
Camera damping/motion drives its own frames and stops when settled; no idle
`useFrame` animation loop is permitted. Async scene publication keeps the old
scene visible until its replacement is ready. Revision-effect cleanup cancels
stale work; it must not dispose the displayed collection. Dispose replaced
resources at the swap or actual teardown, preserving unchanged resources.

## Move, Rotate and Scale

Move, Rotate and Scale are exclusive explicit toolbar toggles. Selecting a
model does not open a gizmo. Arming requires a nonempty eligible selection;
emptying selection closes it. Each numeric panel appears with its tool.
M/R/S toggle the tools and Escape clears selection. Editable fields and
Ctrl/Cmd/Alt-modified key events retain normal text/application behavior.

Model meshes, pivot, gizmo and dependent controls update in the same
interaction turn; do not defer one visual participant to a later frame.
Scale defaults to World; its center handle is uniform and shafts are per-axis.
Transform snapping remains deferred.

All tools capture one start-state transform set and aggregate pivot. Pointer
updates apply a delta from that snapshot to the whole selection, preserving
group relationships. Move-panel X/Y/Z edit the world-space pivot. Rotation
uses world axes; a single selection displays degrees, while a group displays
zero and applies relative deltas. Scale supports World/Local for a single
target; groups use World. Factor fields display actual percentages for a
single target and 100% for a group; size fields edit aggregate dimensions.
Scale remains positive, with a 0.001 floor; mirroring is a separate property.

World scaling composes a full affine transform when necessary. It must not
approximate a sheared result by dropping off-diagonal terms. Move and Rotate
preserve authoritative matrices. Property resets restore the corresponding
load-time value and remove a matrix that would otherwise mask that reset.
Drop to bed uses the true transformed mesh minimum Z.

Part-scoped edits solve the volume transform from the world-space delta and
the unchanged instance transform. A volume belongs to its object, so every
rendered instance copy receives the same volume transform. Instance changes
share scale and X/Y orientation across sibling instances while retaining
independent world-Z rotation and XY placement. All instances of an object
share world Z; a pure Z rotation does not rotate its other instances.

Gesture frames remain renderer-local. Completion commits one native history
transaction through the settled-transform path; cancellation and no-op edits
create no entry. Structural actions wait for that path and abort if it fails.
This synchronization occurs on completion, including before subsequent model
operations. [Undo and Redo](Undo%20and%20Redo.md) owns transaction and restore
semantics; [Per-Plate Print Architecture](Per-Plate%20Print%20Architecture.md)
owns affected-result invalidation.

## Context menus and output modes

Viewport and Object List menus use shared shadcn Context Menu primitives.
Right-drag beyond 4 CSS pixels pans and suppresses the following contextmenu
event. A body click selects the appropriate target and opens its object/part
menu; empty space opens model-import/primitive commands. The native host menu
is suppressed outside editable controls and the shared menu surface.

[Workspace Prepare and Preview Modes](Workspace%20Prepare%20and%20Preview%20Modes.md)
defines the persistent scene, mode-specific controls and preview shell.
[Surface Painting Architecture](Surface%20Painting%20Architecture.md) defines
painting-specific camera, cursor and input behavior. Prime Tower movement is
defined in [Multi-Filament Support](Multi-Filament%20Support.md).

## Verification and boundaries

Regression coverage must distinguish body and gizmo ownership, overlapping
bodies, complete-instance and part selection, additive marquee, affine
roundtrips, sibling-instance synchronization, exact bounds and one-entry Undo.
E2E should target the primary canvas and current projected geometry; demand
rendering may require a fresh pointer move after a tool mounts. Follow the
[testing guidelines](../doc/testing_guidelines.md) for execution scope.
Desktop pointer/keyboard interaction is supported; mobile remains deferred.
