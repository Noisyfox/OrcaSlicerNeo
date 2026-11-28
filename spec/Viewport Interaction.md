# Viewport Interaction

**Updated:** 2026-11-28
**Status:** Measure and the existing viewport interactions are delivered.
Variable Layer Height has an accepted design and awaits implementation.
Release-wide qualification is separate.
The Prepare Cut gizmo supports planar positioning and native project edits. Live section feedback and release qualification are in progress.
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
instance. Preserve relative heights between different objects; instances of
the same object share one height. Do not drop each selected instance independently
or substitute transformed local-box corners for actual vertices.

Objects have an Auto Drop setting shared by their instances. After a Move,
enabled objects are placed on the bed when their model-part minimum Z is above
the native sinking threshold. Rotate and Scale also place an object that was
not intentionally sunk before the edit. Deeper intentional sinking is retained
unless the edit brings the object back above that threshold. Negative volumes,
modifiers and support volumes do not determine the minimum. Auto Drop disabled
is shown by arrows at the selected box's bottom corners. Manual Drop to Bed
remains independent of this setting and keeps the aggregate selection behavior.

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

The Worker settles automatic placement in the same transaction as the final
transform and returns corrected instance positions after commit. A new gesture
for an affected object is blocked until that correction is published; a gesture
that snaps completely back to its previous position creates no history entry
and leaves slice results valid.

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

## Variable Layer Height

Electron and Web share the Prepare editor and the pinned Orca layer-height
algorithms. The implementation and acceptance sequence is recorded below.

### Entry and selection

The Prepare left toolbar provides the sole entry for creating and reopening an
object's layer-height curve. Enable its button when the eligible FFF selection
resolves to one owning model object. This includes a part, a full instance and
multiple instances or parts of that same object. An empty selection or a
selection spanning several objects disables the button. Every eligible
selection edits the curve of the owning object and all its instances.
The first release omits the variable-height icon from the Object List.

### Target changes and pointer behavior

Between strokes the editor follows selection. Picking another eligible object
keeps the tool open and displays that object's curve and color bands. Picking a
different part or instance of the same object retains the current curve.
Switching targets is read-only and creates no undo entry. Clicking empty canvas
preserves the target. A selection that no longer resolves to one eligible
object closes the editor.

A brush stroke begins on the height bar and captures the pointer. Dragging
sideways off the bar continues the same stroke at the height given by the
pointer's vertical position. Normal button release commits an effective stroke
as one edit, including release outside the bar. On window blur or pointer
cancellation, stop continuous brushing and discard the current draft. Earlier
completed strokes remain in the project. A drag starting on a model outside
the bar retains ordinary Prepare model movement. Camera gestures outside the
bar follow the current navigation controls.

### Object ownership and slicing

One `ModelObject::layer_height_profile` holds the ordered Z and layer-height
pairs for all instances of an object. Instances share scale, X/Y tilt and world
Z. Their independent XY placement and rotation about world Z preserve vertex
heights and surface inclination. Orca's adaptive analysis uses the first
instance's transform. Editing through any instance uses the same object profile.
[Native mesh preparation](../packages/slicer-wasm/cpp/src/libslic3r/SlicingAdaptive.cpp)

### Profile display, Smooth and Reset

Opening the editor reads the effective curve chosen by Orca. A first-layer
setting change can make a saved curve temporarily inapplicable. Display the
current effective curve directly, without a warning. Keep the saved curve so
restoring the previous setting can make it effective again. Completing a new
edit writes the new curve. Native 3MF persistence uses
`Metadata/layer_heights_profile.txt`.
[Native profile selection](../packages/slicer-wasm/cpp/src/libslic3r/PrintObject.cpp)

Smooth writes its result to the object even when the curve keeps the same
shape. In particular, smoothing a default straight line can create a saved
profile. Use Orca's `check_object_layers_fixed` on the effective curve to
determine Reset availability. Disable Reset when that check succeeds.
Activating Reset clears the object's saved profile and refreshes the display.
[Desktop controls](../packages/slicer-wasm/cpp/src/slic3r/GUI/GLCanvas3D.cpp)
and [fixed-layer check](../packages/slicer-wasm/cpp/src/libslic3r/Slicing.cpp).

### Editing and visual feedback

The Prepare tool follows the pinned desktop Orca controls.
[Desktop editor](../packages/slicer-wasm/cpp/src/slic3r/GUI/GLCanvas3D.cpp)
and [native layer algorithms](../packages/slicer-wasm/cpp/src/libslic3r/Slicing.cpp).

| Control | Orca behavior used as the design baseline |
| --- | --- |
| Adaptive | Generate a curve from the mesh on activation. Quality / Speed ranges from 0 to 1 and starts at 0.5. |
| Height bar | Left adds detail, right removes detail, Shift + left moves toward the base height and Shift + right smooths locally. Holding the button repeats the action. The wheel changes the brush width from 1.5 to 10 mm, initially 2 mm. |
| Smooth | Smooth the effective curve with radius 1–10, initially 5. Keep min starts off and, when enabled, prevents smoothing from increasing a sample above its previous height. |
| Reset and Close | Reset clears the explicit object profile. Close exits the tool and retains completed edits. |

Use the pinned native brush and smoothing algorithms.

### Layout, model colors and tool settings

Place the controls beside the left Prepare toolbar in the shared tool-panel
position. Reserve the right edge of the canvas for the height bar. The bar
spans the object's full height and shows the base-height reference, curve,
sampled height at the pointer and brush band.

During editing, layer colors replace the normal filament or painted appearance
on the printable geometry of every visible instance of the target object.
This applies even when a part was selected to open the editor. Other objects
keep their ordinary appearance. Restore the target's normal materials on exit.
Surface coloring data stays intact throughout.

Keep Quality / Speed, smoothing radius, Keep min and brush width in window
state. Switching targets or closing and reopening the editor in the same
window retains all four settings. A fresh window starts with the defaults
listed above. The project's 3MF stores the object's layer-height curve.

### Mixed-color warning and slicing behavior

When mixed-color sublayers are enabled, opening the layer-height editor shows
Orca's warning that varying the sublayer thickness may reduce mixing quality.
Also show it when the user enables mixed-color sublayers with an existing
variable-height object, following the pinned Orca object check. Acknowledging
the warning continues the action. Both entry points share one persistent
“Do not show again” preference.
[Orca tool entry](../packages/slicer-wasm/cpp/src/slic3r/GUI/Plater.cpp) and
[mixed-color setting](../packages/slicer-wasm/cpp/src/slic3r/GUI/ConfigManipulation.cpp).

Follow the [painting tool's slice coordination](Surface%20Painting%20Architecture.md#75-existing-slice-jobs-and-runtime-admission).
In threaded WASM, an existing slice can continue during editing. An effective
commit invalidates results on all plates containing an instance of the edited
object and requests cancellation if the active job belongs to one of those
plates. Unaffected jobs continue. Replacement slicing requires a user request.
In serial WASM, editing is unavailable until the slice ends.

A user-initiated Slice between strokes closes the editor before starting the
job with the committed curve. During a stroke, ignore Slice from any entry
point, including shortcuts. Releasing the pointer does not launch a deferred
job. See the [painting Slice command](Surface%20Painting%20Architecture.md#72-user-initiated-slicing).

### Navigation, tool switching and saving

A manual switch to Preview hides the layer-height editor. Returning to Prepare
resumes editing when the target remains eligible. This differs from requesting
Slice, which closes the editor before the job starts.

Between strokes, selecting another available tool closes the layer-height
editor and activates that tool directly. Opening the layer-height editor
similarly replaces the previous tool. Completed edits are retained. During
a stroke, ignore tool-switch shortcuts without queuing them.

Between strokes, Save writes the committed project and keeps the editor open.
During a stroke, ignore Save without opening a dialog or scheduling a save on
release. A later explicit Save writes the newly committed curve.

### Runtime

Use the shared runtime and typed client to call the native algorithms on the
slicer Worker. Build slicing parameters from the effective plate and object
configuration, nozzle selection, first layer and shrinkage compensation. Keep
the working curve in the Worker while brushing. Use native layer boundaries
and texture generation for the display. During a stroke, update the height bar and model bands together
from the same revision of the working curve. The renderer may skip superseded
display frames. Apply every accepted brush action in order, including repeated
actions while the pointer is held still. On release, publish the committed
curve and its matching layer texture.

### Undo and Redo behavior

Keep separate history entries for individual committed strokes and for Adaptive,
Smooth and Reset edits. These entries remain available after closing the tool.
Opening or closing the tool creates no history entry of its own.
Capture the tool's open state with the selection in the project history
frame. On Undo or Redo, restore the curve and the frame's editing context.
Reopen the tool when it was open and the restored target is eligible, and
close it when the restored frame had it closed.

Commit the native object mutation once, update the object's
member plates and preserve results on independent plates. A no-op brush
produces no history entry. A stale object or configuration must not receive
a late stroke. Refresh the curve, model bands and affected plate results
on Undo and Redo.

### Implementation and acceptance

1. **Native editing and persistence.** Read the effective curve and implement
   Adaptive, Smooth and Reset through the typed client. Exercise the fixed first
   layer, smoothing a straight line, changing and restoring the first-layer
   setting, 3MF round trips and per-layer G-code Z comparison with desktop Orca.
2. **Worker brush and preview.** Apply ordered samples to a transient curve.
   Verify all four actions, cancellation, stale input, no-op release and native
   band generation. Only a completed stroke may change the project.
3. **Prepare editor.** Connect the left toolbar, control panel, height bar and
   model materials. Verify eligibility, follow-selection, pointer capture,
   stationary repeats, off-bar release, interruption and painted-color restoration.
4. **Project coordination.** Integrate history, plate invalidation, tools, Save,
   Slice and Preview. Verify undo through a second instance on another plate,
   preservation of a third independent plate, and serial/threaded slice admission.
5. **Mixed-color warning.** Verify both activation orders and the shared persistent
   suppression preference.
6. **Host acceptance.** Replay a continuous stroke in Electron, Chromium and
   WebKit. Compare the final curve and bands with native replay, exercise
   synchronization before release and record input-to-display latency on each
   host. The first release has no common frame-rate threshold.

The [native layer-height fixture](../packages/slicer-wasm/harness/layer-height-smoke.mjs)
checks the 3MF profile and compares every sphere G-code layer Z with desktop
Orca. The P1P 0.4 mm preset produced 118 layers on threaded wasm64. The
Ender-3 0.4 mm preset produced 94 layers on serial wasm32. On serial wasm32
the P1P sphere also traps during slicing with fixed layers on a build from
before the layer-height editor. The [brush fixture](../packages/slicer-wasm/harness/layer-height-brush-smoke.mjs)
compares batched and single-sample results. The
[multi-plate fixture](../packages/slicer-wasm/harness/layer-height-plates-smoke.mjs)
checks history through a second instance and reads back G-code on the independent plate.

The [host replay](../apps/desktop/e2e/layer-height-replay.ts) drives the Prepare
height bar with three samples at Z 12.75 mm and a fourth at 15.9375 mm, all with
a 2 mm brush. It waits for the canvas draw and the model draw with the matching
native texture before releasing the pointer. After Reset it replays the recorded
samples through the host's native Worker and compares every curve value and
every atlas byte with the final displayed frame. The
[continuous brush journey](../apps/desktop/e2e/layer-height-journey.ts)
also exercises the normal stationary-repeat timer and release outside the bar.

On 2026-11-27, each run on Apple M1 with macOS 15.8.3 matched all 43
Z/height pairs and all 20,480 atlas bytes. Latency measures one pointer-down
through the first changed frame drawn by both surfaces while the button was
held. These are draw-submission timings from individual runs. Display scanout
and frame-rate distributions were outside the measurement.

| Host | Worker build | First matching draw |
| --- | --- | ---: |
| Electron | threaded wasm64 | 25.3 ms |
| Chromium | threaded wasm64 | 53.2 ms |
| WebKit | threaded wasm32 | 11.9 ms |
| WebKit | serial wasm32 | 11.0 ms |

## Cut gizmo

**Design accepted, 2026-11-28.** The reference is the Orca core pinned at
`8f2cfb8c79`. The first release delivers basic planar Cut. Subsequent stages
add connected-piece assignment, manual connectors and dovetails. Steps 1–3 below
connect the native operation to the live project and have real-WASM coverage
on wasm64 serial and pthread builds. Step 4 adds the shared Prepare session, plane
handles, numeric height and draft history. Its browser journey exercises the C
shortcut, normal translation, Shift-drag, temporary navigation and cancellation.
Step 5 adds screen-space vertex snapping, immediate side colors and native
section contours. The geometry fixture sweeps a vertical plane through a torus
in both directions and checks the hole on a tilted, mirrored torus. The
renderer coalesces pending poses and drops replies after a pose or session change.
Step 6 exercises the planar workflow in real Web and Electron hosts. Each
positions and applies a cut, undoes and redoes the replacement, arranges the
two results, saves a 3MF, reopens it, checks both positions and slices it.
Step 7 stages connected pieces on the first right click. The Worker keeps the
reviewed parts and their cap-to-section associations. Assigning both sides of
a section to the same object hides that contour. The renderer picks the nearest
triangle on release and uses the same piece indices when applying the cut.

### Native behavior

Orca opens Cut from the Prepare toolbar or with C on one complete instance.
It excludes wipe towers, a standalone dowel and active layer editing. The
tool starts with a planar cut. Users can translate, rotate or flip the plane,
enter a cut height, reset it, or draw a cut line with Shift-drag. Each side
has a keep flag and a choice of original orientation, place on cut, or flip.
The initial settings keep both sides and place the upper side on its cut face.
Cut to parts keeps both sides within one object in their relative orientation.
[Native gizmo](../packages/slicer-wasm/cpp/src/slic3r/GUI/Gizmos/GLGizmoCut.cpp)
and [initial settings](../packages/slicer-wasm/cpp/src/slic3r/GUI/Gizmos/GLGizmoCut.hpp).

The selected instance defines the plane. The operation replaces its owning
object. The core clones the object's instances when producing the results,
and the plater selects the new objects. A cut through one instance can thus
change geometry on several plates. Orca also supports assigning disconnected
pieces to either output, adding manual Plug, Dowel and Snap connectors, and
cutting one or more dovetail grooves. Connectors require both output objects.
Cut to parts is unavailable with connectors, active part selection or dovetails.
[Cut core](../packages/slicer-wasm/cpp/src/libslic3r/CutUtils.cpp) and
[plater result handling](../packages/slicer-wasm/cpp/src/slic3r/GUI/Plater.cpp).

### Confirmed first release and selection

The first public release covers basic planar Cut in Prepare, including plane
handles, numeric height, Shift-drag cut line, side retention and orientation,
Cut to parts, Undo/Redo, project save/reopen and slicing. Connected-piece
assignment, connectors and dovetails are subsequent deliveries toward full
Orca Cut support.

Opening Cut requires exactly one complete instance to define the reference
frame. Apply the same eligibility to the toolbar and C shortcut. Selecting
the object row works when the object has one instance. For an object with
multiple instances the object row selects them all, so Cut stays disabled
and its tooltip says “Select one instance to position the cut plane.” Selecting
one complete instance in the viewport or its instance row enables the tool.
A partial selection within a multipart object is ineligible.
[Native selection predicate](../packages/slicer-wasm/cpp/src/slic3r/GUI/Selection.cpp)
and [Neo selection semantics](ObjectList-and-Parts.md#61-selection-modes-follow-orcaslicer).

Applying Cut replaces the shared object across all its instances. When it
has several instances, the panel shows the affected instance and plate counts
before confirmation. For example, cutting the second of two instances on
different plates uses that instance's orientation to define the plane, and
both plates receive the corresponding results. Verify both plate updates
and their restoration on Undo.

### Confirmed plane positioning and live preview

Store the draft plane as a world-space center `C` and rotation `R` in slicer
coordinates, following Orca. The plane's local X and Y span the cut face.
Its positive normal is `n = R · (0, 0, 1)`, and its world-space equation is
`n · P = n · C`. Derive preview and execution from the same pose. The Worker
subtracts the selected instance offset from the center before constructing
the native cut matrix. The core applies the instance linear transform and
volume transform once, brings the mesh into the cut frame and cuts at local
Z = 0. Verify agreement for tilted, mirrored and transformed multipart
objects. [Native plane state](../packages/slicer-wasm/cpp/src/slic3r/GUI/Gizmos/GLGizmoCut.hpp)
and [core mesh transform](../packages/slicer-wasm/cpp/src/libslic3r/CutUtils.cpp).

The sole numeric position field edits the world Z coordinate of the plane
center, preserving X, Y and rotation. For a vertical plane this moves the
handle center within the plane. Dragging the plane or normal handle translates
the cut along its normal. With viewport focus, Up and Down move it by +1 mm
and −1 mm along that same normal, including for vertical cuts.
[Native keyboard handling](../packages/slicer-wasm/cpp/src/slic3r/GUI/Gizmos/GLGizmosManager.cpp).

The first release includes vertex snapping. Highlight a boundary-edge
endpoint under the pointer using Measure's screen-space marker and pick
radius. A plain left click on the endpoint translates the center by
`dot(V − C, n) * n`, where `V` is the vertex. The rotation stays fixed.
A drag starting there keeps its ordinary gesture, and Shift-drag remains
available for drawing a cut line.

During planar Cut translation or rotation, update the plane, handles and side colors
immediately. Request exact contours, including holes, throughout the gesture.
Coalesce pending requests to the latest pose. Display a contour only when
its target, model revision and plane revision match the displayed pose.
While the current contour is pending, hide the previous contour and keep
the other feedback visible. Verify by slowly dragging across a hole, then
rapidly reversing direction with a preview request outstanding.
[Native section geometry](../packages/slicer-wasm/cpp/src/slic3r/GUI/MeshUtils.cpp).

### Confirmed cut results

By default, keep both sides as separate objects. Place side A (the positive
side of the plane) on its cut face and keep side B in its original orientation.
Users can change either side's orientation independently. Cut to parts keeps
both sides in one object with their relative pose intact. Inherit the source
object's Auto Drop setting. Apply the chosen rotation first. With Auto Drop
enabled, use the native bed-placement rule on each result object. With Auto
Drop disabled, preserve the resulting height even when the user explicitly
chooses Place on cut. Verify with a floating source and a vertical cut.
[Native output transforms](../packages/slicer-wasm/cpp/src/libslic3r/CutUtils.cpp)
and [bed placement](../packages/slicer-wasm/cpp/src/libslic3r/Model.cpp).

Use the same persisted keep-painting preference as Mesh Boolean. It defaults
to off and is edited in application Preferences. With it enabled, use native
remapping for filament, support, seam and fuzzy-skin painting, including the
native treatment of newly created faces. With it disabled, clear surface
painting on the cut result. Part-level filament and configuration settings
retain their own native inheritance rules.
[Shared painting preference](ObjectList-and-Parts.md#results-configuration-and-painting).

Before replacing the source, check result volumes for open edges. If any
have open edges, prompt once for the whole cut with two actions. **Repair and
apply** attempts native mesh repair on the affected volumes before applying
the cut. **Apply directly** accepts the cut geometry as produced. After either
action, the user can undo the applied cut to restore the original model.
[Native Cut workflow](../packages/slicer-wasm/cpp/src/slic3r/GUI/Gizmos/GLGizmoCut.cpp)
and [WASM mesh-repair fixture](../packages/slicer-wasm/src/mesh-boolean/NumericalBackend.test.cpp).

### Confirmed history and navigation

While Cut is open, Undo and Redo step through completed draft edits. Each
drag, confirmed numeric edit, drawn line or vertex snap counts as one action.
Undo stops at session entry. Explicit Cancel discards the draft and its
history. Applying the cut creates one project Undo entry. One Undo restores
the source model and one Redo restores the applied results.

Temporarily switching to another tool retains the plane center and rotation
in memory. Reopening Cut on the same instance with unchanged geometry and
transform restores that pose, recomputes its contour and starts a new draft
history at the restored pose. Discard stale preview replies when leaving the
tool. Explicit Cancel clears the remembered pose for that draft.

Slice and Preview operate directly on the current project model. With a
pending Cut draft, the toolpath therefore shows the model before the cut.
Entering Preview follows the usual cached-result and in-flight slice rules.
Retain the plane just as for a temporary tool switch. On returning to Prepare,
the user can reopen Cut on the unchanged instance and continue editing.
[Preview entry and slice lifecycle](Workspace%20Prepare%20and%20Preview%20Modes.md#5-preview-entry-and-slice-lifecycle).

### Confirmed connected-piece assignment

After the basic planar release, a plain right click on a visible cut piece
switches its assignment between A and B. Resolve the click on release. Once
right-button movement exceeds the viewport's 4 CSS pixel pan threshold,
the gesture pans the camera and leaves the grouping intact. A click handled
by Cut consumes the context menu. Pick the nearest hit piece from the current
preview. [Viewport gesture rules](#context-menus-and-output-modes) and
[native picking](../packages/slicer-wasm/cpp/src/slic3r/GUI/Gizmos/GLGizmoCut.cpp).

When the geometric cut plane changes, discard manual assignments and
classify the new pieces by side. Apply the same rule to dragging, rotation,
keyboard movement, numeric entry and vertex snapping. An in-plane shift of
the center preserves the grouping. Flipping the plane preserves each group
and exchanges the A/B labels. Undoing a plane edit restores both the prior
plane and its manual grouping.

Use Orca's contour-cut output structure. Within each result object, merge
ordinary solid pieces into one volume named for that object. Exclude cut
connectors and modifiers from this merge. Source solids with different
part-level filament assignments or parameter overrides lose their separate
per-part settings on this path. Surface painting follows the global preference.
Verify this distinction with a multipart, multi-filament fixture.
[Native contour-cut merge](../packages/slicer-wasm/cpp/src/libslic3r/CutUtils.cpp).

### Confirmed manual connector editing

When the cut plane moves, project each connector center orthogonally onto
the new plane, following Orca. Parallel translation preserves spacing.
Tilting the plane can change spacing. Revalidate the resulting layout,
identify connectors outside the usable section or in conflict, and disable
Perform cut until the layout is valid.
[Native connector projection and validation](../packages/slicer-wasm/cpp/src/slic3r/GUI/Gizmos/GLGizmoCut.cpp).

Within the Cut draft, distinguish the last confirmed connector layout from
the changes made during the current visit to the connector editor. Confirm
accepts that visit's layout into the draft. Cancel in the connector editor
restores the entry layout, including positions, types, dimensions and
tolerances, and returns to the main Cut panel. Remove all connectors is the
explicit way to clear a layout. Only Perform cut applies the model operation.

Leaving the connector editor for another tool or Preview also discards that
visit's unconfirmed edits. Retain the confirmed layout alongside the plane
for the same unchanged target. On reopening Cut, show the last confirmed
layout. For example, after confirming two dowels and adding a third on a
second visit, both Cancel and switching to Measure retain the original two;
confirming the second visit retains all three. Preview continues to slice the
current project model. Cancelling the entire Cut session discards its draft.

### Confirmed dovetail behavior

The first dovetail release supports single grooves and arrays. Start with
one groove and accept counts from 1 through 100. All grooves share depth,
width, flank and groove angles, and depth and width tolerances. Enable the
clear gap between grooves when the count exceeds one. Display the derived
spacing as the clear gap plus the computed groove width.
[Native dovetail controls](../packages/slicer-wasm/cpp/src/slic3r/GUI/Gizmos/GLGizmoCut.cpp).

While the user drags the plane or edits a groove parameter, update the groove
guide immediately. On release or numeric confirmation, validate the layout
and request an exact Worker preview of the mating solids for the whole array.
Use the same plane and groove parameters for the preview and the applied cut.
Verify a single groove, multiple grooves with a nonzero gap, and an invalid
layout after changing the angle or count. Check the gap and both tolerances
on the resulting meshes. [Native groove computation](../packages/slicer-wasm/cpp/src/libslic3r/CutUtils.cpp).

### Execution boundaries

- Open a Prepare tool session against stable object and instance IDs. Keep
  its plane and output choices in a draft. Give Cut gestures explicit pointer
  ownership alongside camera navigation.
- Execute the synchronous native operation through the typed WASM client and
  shared runtime on the host's Worker. Settle pending transforms, validate the
  target and draft, and stage the results before replacing the source. Copy
  results into project ownership while the native Cut object still owns them.
  Publish the model structure, result selection, plate membership and affected
  slice revisions in one project operation. A failed or cancelled operation
  preserves the original project.
  [Split publication](../packages/slicer-wasm/src/bridge_model_operations.cpp)
  and [Mesh Boolean history integration](../packages/slicer-app/src/components/workspace/viewport/gizmo/meshBoolean/meshBooleanCommand.ts).

### Delivery and acceptance

Implement the following pieces in order. Each row is an independent commit
after its acceptance checks pass. The planar release is complete at step 6.

| Step | Deliverable | Acceptance before commit |
| --- | --- | --- |
| 1 | Real-WASM planar geometry harness using the pinned Cut core | Check a cube, a tilted plane through a hole, each single-side output and Cut to parts. Measure cap closure, hole geometry and retained volume. |
| 2 | Worker-side planar operation on a staged object | Resolve a stable instance and world pose, verify upper/lower and multipart outputs, rotation and Auto Drop. Keep the source intact for an invalid request or failed computation. |
| 3 | Typed Cut command and atomic project publication | Exercise the real client and runtime, cross-plate instances, painting, both open-edge actions, stale edits, Undo/Redo and 3MF roundtrip. |
| 4 | Prepare Cut session, controls and plane manipulation | Test eligibility, affected counts, numeric Z, handles, keyboard, flip, reset, Shift-drag line, cancellation, one-step gestures and temporary navigation. |
| 5 | Vertex snapping and exact live planar contours | Verify screen-space picking and tilted-plane alignment. Drag across a hole, reverse direction and confirm stale section replies never draw. |
| 6 | End-to-end planar release | In Web and Electron, open Cut, position the plane, apply, undo, redo, save, reopen and slice. Check transformed multipart objects, paint, affected plates and relevant WASM variants. |
| 7 | Connected-piece assignment | Verify right-click versus pan, nearest-piece picking, regrouping after plane edits, flip, grouped undo and native solid merging on a multi-material fixture. |
| 8 | Manual connectors | Verify Plug, Dowel and Snap geometry, projected positions, invalid layouts, edit cancellation, detached pins, cut identity and Orca 3MF interchange. |
| 9 | Dovetail release | Verify gesture-end preview and applied mesh agreement for single and multiple grooves, gaps and tolerances. Reject invalid layouts and measure Worker memory on large fixtures. |

The geometry and host fixtures for these checks cover the following cases.

1. Exercise the plane-cut core through a real WASM harness. The source build
   includes the mesh slicer and GLU tessellator used for cut caps. Check a
   horizontal cube, a tilted cut through a hole, each single-side choice and
   Cut to parts. Compare solid count, closed edges, volume and hole geometry.
   [Cut and cap generation](../packages/slicer-wasm/cpp/src/libslic3r/TriangleMeshSlicer.cpp)
   and [WASM build](../packages/slicer-wasm/CMakeLists.txt).
2. Deliver the planar workflow from toolbar entry through publication, Undo,
   Redo, 3MF reopen and slicing in both Electron and Web. Include an instance
   on another plate, negative and modifier volumes, painting preservation,
   nonuniform scale and mirror, an out-of-object plane and cancellation.
   Compare output transforms, settings and geometry with pinned Orca.
3. Add on-demand connected-piece selection. Native Orca temporarily cuts the
   model, splits disconnected solids and associates section contours with the
   pieces on both sides. Keep the exact geometry and that mapping in the
   Worker. Pick by preview-scoped piece ID and commit the reviewed grouping
   through `perform_by_contour()`. Exercise multiple shells, holes and modifiers.
4. Add manual connectors and then dovetails. Port connector placement,
   overlap and depth validation, tolerances, detached dowel output and cut
   group identity synchronization. Exercise re-cutting a group and exchanging
   `Metadata/cut_information.xml` with Orca. For dovetails, validate depth,
   width, angles, tolerances, count and gap against the exact preview. Include
   the pinned connector fixtures and measure peak Worker memory for large
   inputs across supported WASM widths and threading modes.
   [Native connector tests](../packages/slicer-wasm/cpp/tests/libslic3r/test_cut_connectors.cpp)
   and [3MF cut metadata](../packages/slicer-wasm/cpp/src/libslic3r/Format/bbs_3mf.cpp).

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
