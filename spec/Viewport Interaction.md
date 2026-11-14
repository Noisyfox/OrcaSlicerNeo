# Viewport Interaction

**Updated:** 2026-11-13
**Status:** Delivered behavior, including Measure; release-wide qualification
is separate.
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
middle/right drag pans. In Prepare, orbit uses the aggregate world-bounds
center of the selected content (including parts and cross-plate selections),
or the current plate's footprint center when nothing is selected. Preview uses
the current plate center regardless of the retained Prepare selection.
Selection and ordinary plate changes do not reframe the camera: the orbit pivot
is independent of its navigation target and preserves the existing composition.
Each admitted pointer gesture freezes its pivot through the complete damped
rotation. The next gesture uses the latest displayed selection/plate geometry.
Ordinary orbit and painting share the same rigid camera/target rotation; tool
and mode handoffs discard prior inertia without moving the displayed pose.
The orientation gizmo returns to axis-aligned views.
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
- Suspend event-manager raycasting during OrbitControls mouse gestures too.
  A model-body native press stops camera orbit before DragControls crosses its
  drag threshold. Consume the synthetic click after either a body or Move-gizmo
  drag so release cannot collapse a dragged group. A Ctrl/Cmd pointer-down
  toggle also consumes its following click exactly once, without toggling again.

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
Drop to bed computes the aggregate true transformed mesh minimum Z across the
selected instances and applies the same Z translation to every selected
instance. Preserve their relative heights; do not drop each instance
independently or substitute transformed local-box corners for actual vertices.

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

## Measure gizmo design

**Status:** Implemented. Qualification follows the bounded host, runtime and
model scope described below; release-wide qualification remains separate.

### Orca reference

The pinned Orca core separates mesh feature recognition and calculations in
[`Measure`](../packages/slicer-wasm/cpp/src/libslic3r/Measure.hpp) from the
wxWidgets/OpenGL interaction in
[`GLGizmoMeasure`](../packages/slicer-wasm/cpp/src/slic3r/GUI/Gizmos/GLGizmoMeasure.cpp).
Measure operates on mesh-derived features, including fitted circles; it does
not expose original CAD surface parameters. Orca's separate
[`GLGizmoAssembly`](../packages/slicer-wasm/cpp/src/slic3r/GUI/Gizmos/GLGizmoAssembly.hpp)
reuses Measure interaction for assembly operations.

### Confirmed scope and selection

The first delivery includes Orca's Measure feature set and Edit to scale,
with the units exception and edge-midpoint addition below. Assembly is a
separate tool and will be planned separately.

Measure opens for an eligible nonempty model selection and measures only its
selected model volumes. This includes selected objects, instances and parts,
and permits measurements between selected volumes and across objects. Match
Orca's selected-volume visibility: hide unselected model volumes while the
tool is active. Prime Towers are not measure targets and retain their normal
scene visibility rules. To measure across objects, select them before picking
their features.

If the object selection changes while Measure is open, update the visible and
pickable scope and clear both measurement features. Keep Measure open when the
new selection is eligible; close it when the selection is no longer eligible,
including an empty selection or a Prime Tower selection. The scale-driven
update below is a distinct case and retains the measurement features.

### Confirmed feature selection and keyboard input

The tool has two ordered feature selections. Once both are populated, picking
a third distinct feature preserves the first and replaces the second, following
Orca. Keep Orca's existing feature/center selection behavior except for the
confirmed midpoint addition below.

In addition to Orca's circle centers and polygon-boundary centers, expose the
exact midpoint of each recognized straight edge as a selectable point. Show its
marker when the edge is hovered or selected; a user can select the midpoint
directly from the hover marker. If that edge already occupies a selection slot,
clicking its midpoint changes that same slot to the midpoint, rather than
replacing the other slot. Preserve the source edge identity so it can switch
back to the edge as in Orca's feature/center interaction. For an edge carrying
Orca's polygon center, keep that existing center distinct from the midpoint.
The midpoint is halfway between the edge's transformed endpoints; no separate
affine correction is applied to Orca's other features.

While Measure is open, Shift plus a feature click selects a point on that
feature. Disable viewport marquee selection for the entire Measure session;
use the Object List to change the model selection. When the tool closes,
restore the ordinary viewport marquee behavior.

Outside editable controls, both Delete and Backspace clear the measurement
features without deleting model objects. Escape clears the second feature,
then the first, then closes Measure while retaining the model selection.
Editable controls handle their own keys normally.

Click selection uses a native pick for the pointer, viewport and camera at the
press, rather than selecting the most recently displayed hover feature. Claim
the gesture immediately and publish its result asynchronously. Later pointer
motion must not change that click's target. If the relevant session or model
target has been replaced or invalidated, discard the obsolete result. Multiple
admitted clicks retain their input order.

### Confirmed camera and runtime coordination

Follow Orca's camera interaction: a plain left press on a feature begins its
selection and does not move the model; the result is published after the native
pick. Left-drag starting on empty space rotates the camera; Ctrl/Cmd plus
left-drag permits rotation starting over the model.
Middle/right drag pans and the wheel zooms. Gesture ownership is fixed at the
press, so navigating across a feature does not select it.

For an already running slice, follow the existing painting admission policy.
Threaded WASM permits opening Measure and performing read-only measurements
without cancelling the slice. An effective Edit to scale invalidates affected
plate inputs and requests cancellation only for affected in-flight slice jobs,
using the existing transform/result lifecycle. Serial WASM does not admit
Measure during slicing; wait for the slice to finish without cancelling it or
queuing a delayed Measure command. Threaded concurrency requires real-WASM
validation. Entering Preview, including through the normal Slice action, closes
Measure under the existing [workspace mode rules](Workspace%20Prepare%20and%20Preview%20Modes.md).
Home and Device hide the retained Prepare workspace; returning resumes the
same Measure session under those workspace rules, provided its target remains
valid.

While native measurement data is being prepared, show a local preparation
state but allow the user to close Measure or switch tools immediately. A
synchronous native call already running cannot be interrupted: after it
finishes, discard any stale result and release its resources. Do not terminate
the state-owning Worker to simulate cancellation. Other operations requiring
that Worker may wait or be refused by existing admission gates while it is busy.

### Confirmed history and project operations

Undo/Redo remains available under the existing runtime and history gates and
restores the saved selection, active plate and gizmo context. When that context
restores an eligible Measure tool, clear both measurement features and results;
do not attempt to restore old feature pointers. This includes undoing or
redoing an Edit to scale. Follow the ordinary history context if it restores
another tool or an ineligible selection.

Object, part, instance and plate operations follow the ordinary scene-selection
lifecycle. When the model projection changes, reconcile the selection and
active gizmo using the same path as other tools. If a measurable selection
remains, Measure follows that selection and clears features when its target or
geometry changes; if none remains, it closes. Delete and Backspace inside
Measure retain their measurement-reset behavior described above. A later
selection does not automatically reopen a closed tool. Undo/Redo and Measure's
own Edit to scale use their separate behaviors described above.

For New, Open and Reload Project, follow the idle painting lifecycle: run the
existing file selection and unsaved-project confirmation first. If the user
cancels, or a requested save does not succeed, keep Measure open. Once the user
confirms continuation and any requested save succeeds, close Measure before
replacing the old project. Project closure and post-close load failure follow
the existing [project replacement boundary](Undo%20and%20Redo.md#52-project-replacement-boundary).

### Confirmed units and presentation

The first release displays and accepts lengths in millimeters only; inch
display and input are deferred. It introduces neither a Measure-local unit
switch nor a global unit preference. Display lengths, angles and XYZ values
with three decimal places, following Orca. Formatting does not round the native
measurement used for calculation or the scale ratio.

The Prepare tool card presents the selected features and available results.
The 3D view shows the corresponding feature highlights, dimension lines,
angle arcs and labels. Place Edit to scale next to an eligible dimension label
in the 3D view, following Orca, while retaining Neo's existing tool-card layout.
Each result row provides Orca-style copy of its label and formatted value.
Invoke clipboard access from the user action through a host-compatible browser
or injected capability; report an unavailable or failed copy instead of
claiming success.

### Confirmed Edit to scale behavior

For an editable dimension, request a uniform relative scale for the entire
current model selection as one joined selection, even if other selected
objects were not used to pick either measurement feature. The requested ratio
is the desired value divided by the current measured value. Use the existing
Neo Scale path and its 0.001 positive floor for the relative factor and stored
scale values. If a limit applies, the resulting dimension can differ from the
requested value and individual selected transforms may be limited differently;
show the actual recomputed measurement. Do not bypass that shared scale policy
or reject the request solely because it reaches the floor. Follow Orca's
entrance condition: a measurement whose features belong to different rendered
volumes does not expose Edit to scale, including different parts of one object.

The 3D dimension label opens a modal editor, following Orca. Enter and the
confirmation button apply; Escape or Cancel closes the editor without changing
the measurement selections. Confirming zero, a negative value or an unchanged
value closes the editor without changing the model or creating an Undo entry.
Preserve the unrounded original value while editing: simply opening and
confirming a three-decimal display must not introduce an unintended scale.

After a successful scale, keep Measure and its selected features open and
recompute the displayed result using the resulting transforms. This is not an
ordinary selection change and must not clear the features. The existing
settled-transform and history boundary governs the one scale edit; cancellation
and no-op edits produce no history entry. A measurement without a scale edit is
temporary state and does not modify or dirty the project.

### Confirmed affine behavior

For nonuniform scale, mirroring and shear, initially retain the pinned Orca
feature-transformation and measurement behavior, including its existing plane
normal and circle-radius handling. Do not introduce a Neo-only correction or
an ellipse-specific downgrade. Follow an upstream fix when it is incorporated
into the core. Affine correctness beyond Orca's current behavior is not claimed.

### Confirmed mesh and resource policy

Retain the pinned Orca behavior for mesh feature recognition, including its
current behavior on open, damaged or degenerate meshes. Do not add a separate
mesh-quality or non-finite-feature detection path, a Measure-specific error
warning, or a point-measurement fallback for those cases. If a result cannot
be represented across the WASM/JSON boundary, apply the existing generic
runtime error handling rather than inventing a successful measurement. Follow
upstream changes when incorporated into the core.

Do not impose a Measure-specific triangle-count ceiling or silently simplify
input meshes. Existing native representation, WASM memory and device resource
limits still apply. Record startup, hover, memory and cleanup observations for
representative models during acceptance; measured cases do not promise that
every model will complete or set a product size limit.

### Other product behavior

- Offer Measure in Prepare's existing exclusive tool-card system. U toggles
  Measure, following Orca. Use Orca's selection, reset and center semantics
  wherever the confirmed midpoint or other explicit decisions do not alter them.
- Recognize point, edge, circle and plane features, including the center
  selections Orca exposes.
  Show the recognized feature, a single edge's length or circle's diameter,
  and the native result's available angle, distance, perpendicular/direct
  distance and XYZ components. A result may be absent for combinations the
  native algorithm does not support. Follow Orca's rules for suppressing equal
  strict/infinite distances and XYZ output below its epsilon.
- Provide screen-sized markers and labels, individual reset and keyboard
  restart. Use the existing gizmo card header's Close control without a
  separate Done action. Match Orca's result-row copy format and selection
  promotion when the first feature is cleared.
- The first delivery targets desktop pointer and keyboard use in both hosts.
  Mobile interaction and qualification are deferred.

### Implementation direction and lifecycle

The shared React viewport owns input, tool state, visualization and controls.
The renderer reaches the slicer through the runtime; only the typed WASM
client accesses Emscripten. Web runs it in a browser Worker; Electron uses a
Node Worker in its utility process, as defined by the
[shared architecture](Web-Electron%20Shared%20Application%20Architecture.md).

A headless native measurement session owns source-mesh lifetimes,
acceleration structures, `Measuring` caches and feature selection. Resolve
selected targets by stable object/instance/volume IDs and a project/session
generation; retain mesh and transform revisions so a replacement or changed
target cannot reuse a stale feature or pointer. Keep native feature pointers
inside the Worker. Expose typed open, hover, selection, reset, display-resource
and close operations through the existing synchronous JSON bridge and typed
client; large display resources use the existing WASM heap/binary ownership
rules. There is one current contract, with its producer, client, runtime,
mocks and consumers updated together.

The result contract identifies the session and target revision, selected
source/feature and marker identities, geometry required for point, edge,
circle and plane visualization, and Orca's optional angle, infinite/strict
distance and XYZ results with their dimensioning points. A missing native
result remains absent; no independent TypeScript approximation supplies it.
The project/model history does not own transient feature handles. Update the
scene controller's history-context restoration to recognize Measure and open
a fresh eligible session with empty features; the current restoration path
only recognizes Move, Rotate and Scale.

Native picking would use the source mesh, camera and viewport snapshot to
identify the nearest eligible hit before asking Orca for its feature. The
renderer BVH can reorder triangle indices, so its `faceIndex` is not an
authoritative original triangle ID; see
[`GLVolume`](../packages/slicer-app/src/components/workspace/viewport/GLVolume.ts).
The existing
[painting picker](../packages/slicer-wasm/src/painting/PaintingSession.cpp)
is a reference for native ray construction and transform validation. The
renderer may use a reliable BVH miss as a preflight, but a click must be
confirmed for its own pointer/camera snapshot and may not commit stale hover.

Mesh hits alone cannot implement the interaction: circle and polygon centers
can lie away from the source surface, while edge, circle and point grippers have
their own screen-sized picking regions. The native adapter must also resolve
visible tool markers and selected-feature grippers for the captured click and
preserve Orca's hit priority and selection identity. Adapt Orca's point-on-edge,
point-on-circle and point-on-plane projection logic without porting wxWidgets
or the native GUI; add the confirmed edge midpoint as a separately identified
point with its source edge. Any displayed-marker identity passed from the
renderer must be tied to the current session/resource revision and rechecked
for the click; stale hover or an unvalidated renderer face index cannot select
a feature. A BVH miss against the source mesh alone is not sufficient to reject
a click on a visible tool marker.

Use Orca's `get_measurement` semantics for feature pairs, including its GUI's
circle-result mode. Native plane selections must carry the transformed boundary
features needed by pair calculations. The adapter keeps source features and
their referenced mesh resources alive through selection, scale and display;
only compact value descriptions, marker identities and display resources cross
the typed boundary. Preserve Orca's selected-feature/center switching and
single-circle measurement behavior in addition to the midpoint extension.

Hover scheduling retains at most one in-flight hover and the latest pending
hover, discarding obsolete hover responses after pointer, camera, selection,
geometry or session changes. A confirmed click is a separate ordered command:
ordinary later pointer or camera motion must not substitute a later hover for
its captured input. Return compact feature and result data and cache
plane-highlight geometry as binary resources rather than copying entire meshes
per hover. It may use native original-triangle indices and retained original
renderer buffers when their geometry identities match. The scene must
invalidate when an asynchronous display is published, and release replaced
resources and native caches on invalidation or close.

To match selected-volume measurement, the current single-instance tool
isolation in [Application Shell](Application%20Shell.md#tool-instance-isolation)
may need a shared selected-volume scope. Rendering and picking must agree on
visibility, and cleanup from a replaced tool must not release its successor's
scope. The currently delivered single-instance tools retain their existing
visibility semantics. Invalidate stale work whenever an admitted operation or
history restore changes its targets; accepted project-operation rules above
govern user commands that would mutate the measurement geometry.

### Feasibility and verification

`Measuring` copies its input mesh and builds plane and adjacency data on
construction; subsequent feature extraction is partly lazy. Measure session
startup, hover responsiveness, peak memory and cleanup need real-WASM
measurement on representative models. Open or damaged meshes, degenerate
geometry and non-finite results also need evaluation to document actual Orca
and WASM behavior without silently adding the rejected fallback or detection.

Verification covers the supported feature pairs and native result
semantics against pinned Orca reference fixtures; click-time picking despite
stale hover; overlapping and multiple targets; point, center and midpoint
picking, including markers away from the source surface; transformed midpoint,
mirror and affine parity with the pinned Orca core; stale asynchronous results;
tool/camera/keyboard ownership, including disabled marquee and non-destructive
Delete/Backspace; millimeter-only three-decimal presentation without rounding
the underlying calculation; stale preparation cleanup; threaded/serial slice
admission; guarded geometry changes and their Undo/Redo/project-replacement
exceptions; resource release; clipboard result/failure; and scale/Undo/Redo.
Scale coverage must distinguish the full selection from the measured volume,
reject cross-volume editing, exercise nonpositive/unchanged inputs and the
existing scale floor, and retain/recompute the chosen features after a
successful scale, including when the result differs from the entered value.

Verify the native session and ABI with real WASM, including serial and threaded
execution and both shipped Web address widths. Exercise shared UI/input in one
primary host, and verify clipboard and runtime-selection seams in the other
affected host. Mock tests are not evidence for native results or memory
behavior. Apply the staged package, host and variant checks in the
[testing guidelines](../doc/testing_guidelines.md); report the measured model,
device and variant scope rather than claiming untested limits or performance.

## Context menus and output modes

Viewport and Object List menus use shared shadcn Context Menu primitives.
Right-drag beyond 4 CSS pixels pans and suppresses context menus. Right-button
clicks open only after release, whether the host sends `contextmenu` on press
or release; cancelled gestures never open a menu. A body click selects the
appropriate target and opens its object/part menu; empty space opens
model-import/primitive commands. The native host menu
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
