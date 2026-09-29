# Surface Painting Architecture

**Date:** 2026-09-29

**Status:** Accepted architectural direction; grouped product and lifecycle
clarification in progress. Implementation has not started.

**Scope:** A shared surface-painting architecture for OrcaSlicerNeo, with
multi-material painting as its first gizmo and reusable foundations for support,
seam, and fuzzy-skin painting.

This is a major architecture specification alongside [Grand Plan](Grand%20Plan.md).
It is the single living record for this work, created directly in `spec/` at the
user's request. Accepted decisions below are binding; unresolved topics in
section 10 are not implicit implementation defaults. Clarifications are folded
into this document after a related group of questions has been resolved, rather
than after every individual answer. Each question must include the corresponding
behavior of the pinned Orca source as a reference.

## 1. Relationship to existing specifications

- [Web-Electron Shared Application Architecture](Web-Electron%20Shared%20Application%20Architecture.md)
  remains the host, Worker, and native-module boundary.
- [Painted Facet Model Rendering](Painted%20Facet%20Model%20Rendering.md) governs
  ordinary Prepare and Preview display of committed painting. This specification
  adds editing without turning those display resources into the editing model.
- [Undo and Redo](Undo%20and%20Redo.md) supplies native history ownership and
  transaction coordination. Its reserved nested/coalesced capability must be
  extended for the session behavior specified here.
- [Multi-Filament Support](Multi-Filament%20Support.md) and
  [Per-Plate Print Architecture](Per-Plate%20Print%20Architecture.md) continue to
  govern material slots and committed slicing inputs.

No delivered milestone is claimed by this design record. Implementation and
verification must follow the [testing guidelines](../doc/testing_guidelines.md).

## 2. Accepted direction and reusable boundaries

Use the existing slicer WASM module in its existing Worker (proposal A). Reuse
the native `TriangleSelector` algorithms and `FacetsAnnotation` representation.
React/Three.js owns interaction presentation and drawing. Application access
continues through `slicer-runtime`; only `slicer-wasm/src/client/` may directly
access the Emscripten module. Both Electron and Web use the same feature.

The reusable architecture separates:

1. Painting mode: scene rendering, camera navigation, cursor, and input routing.
2. Native editing session: authoritative hit testing, stroke processing,
   selector lifetime, selection/fill algorithms, and draft display output.
3. Session history: ordered child edits, navigation, non-paint separators,
   per-stroke commits, and closure compaction.
4. Annotation adapters: native field, legal states, display semantics, response
   to external edits, immediate invalidation, and deferred derived updates.

| Feature | Native annotation | State semantics |
| --- | --- | --- |
| Multi-material | `mmu_segmentation_facets` | Default and explicit material slots |
| Support | `supported_facets` | Default, enforce, block |
| Seam | `seam_facets` | Default, enforce, block |
| Fuzzy skin | `fuzzy_skin_facets` | Default and enabled |

Each annotation retains its own subdivision tree and state. Shared numeric
values do not imply shared business meaning. Specialized operations such as
automatic support generation need not be generalized into brush algorithms.

Retain native 3MF and slicing compatibility. Erasing multi-material painting
restores state zero, not an explicit assignment to the currently displayed base
material. Annotations belong to a volume and are shared by its instances.

### 2.1 First-release multi-material tools

The first release includes all six tools exposed by the pinned Orca multi-
material painter: circle brush, sphere brush, triangle painting, height-range
painting, region fill, and gap fill. Implementation may proceed in independently
testable pieces, but the first release is not complete until all six are
delivered. Section view/clipping, wireframe display, vertical/horizontal painting
restrictions, and the gizmo's own filament-remapping UI are deferred beyond the
first release. This does not defer the already-required project-level slot
Delete/Merge with integration. Keep the reusable architecture extensible for
these auxiliary capabilities without making their UI or implementation a
first-release deliverable.

Circle and sphere brushes use a world-space radius in millimetres. Label the
control as Radius with unit mm; camera zoom changes its apparent screen size
without changing the physical paint coverage. The first release does not offer
a fixed-pixel brush-size mode. Native hit testing and the displayed cursor must
agree on this radius, including on transformed objects.

Retain Shift plus left button for local erasing and the Erase all action for
the active object's solid model parts. Also provide an explicit erasing-mode
switch in the panel so local erasing does not require a modifier key. Both
local and whole-object erasing restore the unpainted state, which resolves
through each part's effective material assignment.

Selected painting colour, erase state, and brush size are live settings during
a stroke. Changes affect subsequent samples without retroactively changing
earlier painted regions. The complete press-to-release sequence remains one
child history operation even when these settings change. These tool settings
are distinct from project parameter edits and filament-slot mutations, whose
commands are ignored during an unfinished stroke under section 3.2. Tool-type
switch commands are also ignored while a stroke is unfinished, without queuing
or changing the active algorithm. The user must switch tools again after the
stroke ends. This applies to both panel and shortcut commands.

### 2.2 Region fill and height-range interaction

Region fill supports holding the painting button and dragging across successive
regions. Native selection and fill are applied along the input trajectory; the
complete press-to-release sequence remains one child history entry, rather than
one entry per filled region. The native hover preview is specified in section 4.

Expose Orca's geometry-edge detection toggle and angle threshold for region
fill. Initially enable detection with a 30-degree threshold; the supported
angle-control range is 0 through 90 degrees. Disabling detection removes this
angle constraint from native region selection. Parameter changes refresh the
candidate preview, and preview and actual fill use the same settings. This is
part of the first-release fill tool, not the deferred vertical/horizontal
painting restriction feature.

Height-range painting follows Orca's pointer-driven interaction. The user sets
a height h in millimetres; native raycasting determines the hit point's world Z,
which is the lower bound of the band [Z, Z + h]. Clicking or dragging applies
the native height-range selector, including eligible solid parts of the active
object intersecting the same band. The band follows world Z rather than a
rotated part's local axis. The first release does not add a separate numeric
lower/upper-Z Apply workflow.

### 2.3 Gap-fill interaction

Gap fill operates on all solid model parts of the current editing object, not
only a pointer-selected area and not all objects touched earlier in the session.
The user sets a small-region area threshold and invokes Apply to merge eligible
painting regions into neighbouring regions. This cleans up facet painting; it
does not repair holes in the source mesh.

Changing the threshold previews the resulting colours in real time. Native code
owns candidate-region and destination-state calculation. Preview changes do not
write committed annotations, change project dirty state, or create history.
Only Apply commits the result, as one painting child history operation covering
the affected parts; an ineffective Apply creates no entry. The operation follows
the same immediate invalidation, deferred derived updates, and painting-run
compaction rules as other painting edits. Preview and Apply must use matching
input state and threshold; obsolete asynchronous previews cannot replace newer
ones. Follow Orca's neighbour-choice rule: choose the numerically smallest
adjacent facet state from the ordered set of neighbouring states. State zero
(unpainted) takes precedence when present. Do not substitute a largest-area or
longest-shared-boundary heuristic. Preview and Apply use this same rule.

## 3. Dedicated painting mode

Opening a painting gizmo changes the viewport to a dedicated drawing and input
mode. It must not layer editing on the ordinary Prepare model/body-drag path.

The painting mode owns selector-derived draft surfaces, cursor rendering,
candidate-region highlighting, and any enabled contours, wireframe, or clipping
presentation. Ordinary object selection, body dragging, box selection, and
transform gizmo handlers do not compete for its painting gestures. Camera
navigation remains a separate interaction. During an unfinished stroke, ignore
camera rotation, pan, and zoom gestures without queuing, committing, cancelling,
or pausing that stroke. Keep the camera unchanged for the stroke; navigation
becomes available again after it ends. These gestures must not be confused with
live brush-size adjustments. Concrete navigation bindings remain to be clarified.

The Canvas, camera, and immutable source resources may be shared with Prepare;
dedicated mode does not require a second WebGL context. Draft display resources
remain separate from committed `GLVolume` paint resources. Closing returns to
ordinary Prepare rendering after the committed resources are ready.

### 3.1 Editing scope and entry condition

Selecting a part before opening the gizmo identifies its owning object; it does
not restrict painting to that part. All solid model parts of the target object
are eligible for painting. Modifiers and other non-model-part volumes are not
paint targets.

Multi-material painting requires at least two filament slots to open. This is
an entry-only gate: reducing the count to one during an open session keeps the
gizmo open and permits continued painting with the remaining slot. Do not reuse
the entry gate as an ongoing-session closure condition. Reopening after closure
still requires at least two slots.

Painting mode displays only the active editing instance. Other objects and
other instances of the same object are hidden. The final annotations still
belong to the shared volumes and therefore affect the other instances too.

### 3.2 Explicit closure and Escape

When no stroke is active, Escape behaves like the toolbar close action:
retain the committed strokes, compact history, complete deferred updates, and
return to Prepare. It does not discard painting or ask whether to apply it.

During an active stroke, Escape cancels only that stroke and keeps the gizmo
open. Restore the draft to its pre-stroke state and do not create a history
entry for the cancelled stroke. Earlier completed strokes and interleaved
non-paint edits remain intact. A subsequent Escape while idle performs normal
closure. Late samples or release events from the cancelled stroke must not
resume it or cause an implicit close.

Other lifecycle actions and camera bindings remain subject to section 10
clarification.

While a stroke is unfinished, ignore Save, Undo, Redo, explicit gizmo-close,
Prepare-to-Preview, user-initiated Slice, parameter-edit, and filament-slot
adjustment commands. Do not queue them, apply their project changes, open their
dialogs, commit or cancel the stroke, navigate history, or begin closure.
The user must issue the command again after the stroke finishes. Apply this
rule across shortcuts and other command entry points. Escape retains its
stroke-cancellation behavior above. If focus loss has already ended the stroke
before a parameter or slot command arrives, process it as an ordinary between-
stroke edit. Other project mutations are not implicitly covered by this rule.

Window focus loss, system pointer cancellation, or unexpected loss of pointer
capture ends the current stroke by committing its effective painted portion,
using the same atomic commit/history and invalidation rules as pointer release.
Keep the gizmo open; an empty stroke creates no history entry. Ignore late samples
and release events belonging to the ended stroke. Merely moving outside the
canvas while pointer capture remains valid is not an interruption. Normal
capture release after an already completed stroke must not commit it twice.

### 3.3 Navigation and editing-target changes

When no stroke is active, switching from Prepare to Preview closes the painting
gizmo and compacts its history, even when the user did not explicitly request
slicing. Returning to
Prepare does not automatically reopen the gizmo. This decision does not yet
define behavior for Home, Device, or other top-level pages.

Selecting another eligible object through the Object List keeps the same
painting session open. Rebind native picking, selectors, and isolated display
to the newly active target, while retaining the earlier targets' child history.
Undo/Redo remains available across objects until the session closes. Selecting
another part of the same object does not narrow the whole-object painting scope.

A pure selection change does not mutate the project, create an independent
history entry, or separate a continuous paint run. Consequently a compacted
paint run can contain changes to several objects. Target identities and editing
context must remain valid during cross-object history restoration.

If selection is cleared or otherwise ceases to satisfy the painting target
eligibility conditions, close the gizmo normally, retain committed strokes, compact history,
and complete deferred updates. Do not keep an inactive painting session waiting
for a later valid selection. The active-stroke Preview command is covered by
section 3.2; target changes during an unfinished stroke remain to be clarified.

## 4. Cursor preview and authoritative native picking

The React-side BVH is used only to locate the cursor visually on the original
model. Its hit point, `faceIndex`, and selected hit volume do not determine a
painting operation. No BVH is built over the subdivided paint display geometry.

Once the pointer is pressed, native code performs all painting hit tests and
face identification. The frontend sends the ordered pointer input and the
camera/viewport information needed to reconstruct the corresponding rays. The
native session determines the eligible target, nearest hit, original face,
local hit coordinates, clipping, and transformation semantics, then invokes
`TriangleSelector` to locate or modify subdivided facets.

The frontend must not discard a painting sample because its cursor-only BVH
reported a miss. Native code also owns trajectory interpolation and continuous
brush coverage, including transitions between parts and off-surface intervals.
Region fill includes a hover preview that highlights the candidate area before
clicking. Native code performs the candidate hit test and region calculation;
cursor hits are not an input authority for fill selection. Preview changes do
not modify committed annotations, mark the project dirty, or create history.
Moving off the model or onto another part clears or replaces the old candidate.
Outdated asynchronous candidates must not overwrite the current preview.

Input and output carry session/order identity so late responses cannot overwrite
a newer session. Releasing a stroke waits for all accepted samples belonging to
that stroke. Preserve the ordering of live tool-setting changes relative to
samples, so delayed Worker processing uses the colour, erase state, and size
applicable to each sample rather than the latest UI values. Precise batching,
backpressure, camera-snapshot transport, and
cancellation behavior are to be finalized before implementation.

## 5. Per-stroke commits and deferred derived updates

Only the active, unfinished stroke is a draft. At pointer release, drain its
accepted samples, atomically write the changed native annotations to the live
model, and record one navigable child history operation. A failed commit retains
the stroke state for recovery without partially changing the model or history.
An empty stroke creates no history entry. Closing the gizmo does not write the
completed strokes again.

Immediately after each effective commit, advance the affected slice-input
versions and make obsolete slice results unusable. Heavy derived work,
including material-use summaries and Prime Tower projections, is deferred until
gizmo closure or an operation actually requires it. Deferred work must not make
an obsolete cache or slice result appear current. The active-job cancellation
and admission policy for each WASM variant remains a runtime clarification.

Undo/Redo of painting restores the committed native annotations and synchronizes
the active selectors/display. It follows the same immediate-invalidation and
deferred-recomputation policy as a new stroke. Active-stroke Escape cancellation
does not change committed state or trigger its invalidation.

The dedicated painting display continues to update during strokes. Ordinary
Prepare paint resources may be refreshed when needed, and must match the
committed model before they become visible again.

Non-paint project operations retain their normal semantics and history order.
They operate on the latest committed model, including all completed painting
strokes. Parameter and filament-slot commands received during an unfinished
stroke are ignored under section 3.2. Other project mutations during a stroke
remain to be clarified.

## 6. Nested history and compaction

### 6.1 Expanded session history

Use nested history with navigable child edits while the gizmo remains open.
Individual strokes are undoable only during that open session. Non-paint
project mutations participate in the same chronological order rather than in
an unrelated paint-only undo stack.

While the gizmo is open, Undo stops at the project state at session entry. It
cannot navigate into earlier project history, including through a history-jump
UI. Reaching this boundary keeps the gizmo open and permits Redo of session
edits. The user must close the session before undoing earlier project operations;
normal closure compaction and conditional Redo removal still apply.

The session is a history container, not a long-held instance of the current
exclusive native transaction. Individual commands still require atomic,
serialized execution through the project mutation coordinator. The existing
coalesced child transaction merely joining its parent is insufficient: the new
history capability must retain child states for navigation and non-paint edits
as independent boundaries.

### 6.2 Collapse continuous paint runs on close

On closure, each continuous run of painting edits collapses to one semantic
history operation. Every intervening effective non-paint project operation
separates runs and retains its own history identity.

```text
While open:
  stroke A -> stroke B -> change layer height -> stroke C -> stroke D
  -> adjust filament slot -> stroke E

After close:
  paint AB -> change layer height -> paint CD -> adjust filament slot -> paint E
```

Hover, camera movement, and brush UI adjustments do not create project history
or split a paint run. Save does not split a paint run either. Empty strokes do
not create entries. Closing removes the
stroke-level granularity; reopening must not resurrect those child nodes.

Recording or compacting history is distinct from publishing model state.
Compaction must not replay intermediate states through the live model and
trigger repeated derived-state updates.

### 6.3 Redo on closure

Closure uses the current history cursor, never an automatically redone state.
If any effective project mutation was successfully committed during this session,
successful closure discards
**all Redo**, including paint children, non-paint redo operations, and any
previously retained redo branch. No redo branch is compacted and retained in
that case.

This is a session-lifetime condition, not a comparison of the closing state with
the opening state. Both effective painting commits and effective non-paint
project edits count. Undoing every edit back to the opening state does not reset
the condition; closure still removes all Redo and does not create an empty
painting entry. Saving does not reset the condition either.

If no effective project mutation was committed during the session, closing
preserves the existing Redo branch. Hover, camera/brush UI changes, empty strokes,
and cancelled unfinished strokes do not set the condition. Preservation does not
reconstruct any branch already discarded by an actual project mutation.

History compaction and redo removal must be atomic. Failed closure retains the
open session and navigable history; completed strokes remain committed.

### 6.4 State ownership

Each completed stroke and non-paint edit records an actual committed native
project state. No parallel session-wide draft history or conversion from draft
roots to committed roots is needed. Use stable identities and shared immutable
mesh resources; display geometry is not the history authority. Compacted entries
must restore correct annotation/configuration combinations without retaining a
closed editing session or its stroke-level nodes. The checkpoint for cancelling
an unfinished stroke remains local to that stroke.

Compaction, saved-marker handling, and child navigation must be proved
independently of viewport rendering.

## 7. External operations and session closure

Global/scoped configuration and filament-slot operations can separate paint
runs without closing the session. Slot operations apply to committed annotations
and synchronize the active selectors. Palette changes affect display; deletion,
merging, or reordering requires coordinated native state mapping. Historical
nodes remain paired with their historical material definitions. During an active
stroke, parameter and slot commands are ignored under section 3.2.

Painting uses the project's existing slot Delete and Merge with semantics from
the Multi-Filament Support specification; the gizmo does not define an alternate
mapping policy. Delete removes painting marks for the deleted slot, while Merge
with remaps them to the chosen surviving slot. Higher slot references shift to
preserve their logical material. Slot changes and all affected annotation
remapping form one atomic project history operation, including annotations on
objects outside the current editing target. Undo/Redo restores both the material
definitions and their corresponding painting state together. An effective slot
operation remains a non-paint separator during session compaction, even though
it also changes painted facets.

Synchronize the active painting colour, selectors, and display with the resulting
project mapping. A failed operation must not partially apply slot changes or
annotation remapping. A successful reduction to one slot retains the open gizmo
under section 3.1.

### 7.1 Save while painting

With no unfinished stroke, Save writes the current committed project while
keeping the gizmo open and preserving stroke-level Undo/Redo. Saving does not
compact painting history or separate continuous painting runs. For example,
`stroke A -> stroke B -> Save -> stroke C -> stroke D` becomes one `paint ABCD`
entry on closure, provided no effective non-paint edit intervened. The saved
`AB` state is no longer individually reachable through Undo after compaction.

Use Orca's conservative saved-marker policy. If compaction removes the saved
history node, transfer the marker to a retained node only when history semantics
establish that it represents the same project state. If no such node exists,
mark the saved checkpoint unknown and report the project as modified until the
next successful save. Do not split a painting run or retain a child node solely
to preserve the saved marker. This policy does not require content-based state
equality and may conservatively report unsaved changes even when project content
matches the saved file. A retained or equivalently remapped marker continues to
participate in normal dirty-state tracking. Save during an active stroke is
ignored under section 3.2, without a dialog or deferred save request.

### 7.2 User-initiated slicing

With no active stroke, a user-initiated Slice action first closes the painting
gizmo, compacts history, applies the conditional all-Redo removal rule, and
completes required deferred
derived calculations. Only then may slicing start. Failure to close or prepare
the required state must not start the requested slice. This policy applies to
all user-facing Slice entry points, including shortcuts, not only a toolbar
button. During an active stroke the Slice command is ignored under section 3.2.
Already-running background slice work is a separate runtime topic.

### 7.3 Closure publication

Closing validates the session and compacts the already-committed history without
replaying model mutations. Complete deferred painting-related calculations for
the affected objects and plates, including other instances sharing the edited
annotations. Ordinary Prepare resources become visible only when they match
the committed state. Do not repeat invalidations or calculations already settled
for the same input version.

Active-stroke Escape cancellation and ignored commands are defined in section
3.2. Other pending-input cases, any whole-session discard action, source-mesh
replacement, target deletion, export, other page changes, and application
shutdown are deliberately not settled here.

## 8. Native Orca reference and Neo differences

The research baseline is the pinned Orca submodule commit
`c7801bdbdbfb0ca1176c2c69792a65fdd4f2db0d`, inspected with Neo at `f3d3e040`.
Reference behavior is source-derived, not an assertion about a newer release.

- [TriangleSelector](../packages/slicer-wasm/cpp/src/libslic3r/TriangleSelector.hpp)
  owns facet subdivision, brush/fill selection, and compact serialization.
- [Painter base](../packages/slicer-wasm/cpp/src/slic3r/GUI/Gizmos/GLGizmoPainterBase.cpp)
  owns native raycasting, trajectory processing, selector rendering, and
  ordinary-picking suppression in painting mode.
- [Multi-material gizmo](../packages/slicer-wasm/cpp/src/slic3r/GUI/Gizmos/GLGizmoMmuSegmentation.cpp)
  initializes selectors and writes their results to native annotations.
- [Plater history](../packages/slicer-wasm/cpp/src/slic3r/GUI/Plater.cpp)
  calls `reduce_noisy_snapshots` when leaving a gizmo with an action; its comment
  explicitly describes reducing consecutive gizmo-action runs.

Orca writes selector results back at stroke release; Neo follows that commit
boundary. Neo explicitly separates immediate invalidation from heavy derived
recomputation and defines its session-history behavior above. Orca's Save path
can retain an open multi-material gizmo, while its Slice button exits the gizmo
before updating and slicing; the corresponding Neo policies are in section 7.
wx/ImGui/OpenGL classes are references, not components to compile into WASM.

## 9. Required validation themes

- First-release coverage includes all six multi-material tools, modifier-based
  and explicit-mode local erasing, and whole-object Erase all.
- Circle and sphere brush radii use mm and preserve physical coverage under
  camera zoom; cursor display and native selection agree on transformed objects.
  Deferred auxiliary features are not first-release acceptance requirements.
- Colour, erase state, and brush size changes affect subsequent samples in the
  same stroke. Delayed or batched input preserves their ordering, and Undo/Redo
  treats the resulting mixed-setting stroke as one child entry.
- Region-fill hover highlights the native candidate region without project or
  history mutation. Misses, part changes, and stale responses cannot leave an
  obsolete region highlighted.
- Region fill initially enables edge detection at 30 degrees, accepts 0 through
  90 degrees, and can disable the angle constraint. Preview and fill use the
  same parameters after changes.
- Dragging region fill across multiple regions produces one child history entry
  for the entire stroke; Undo/Redo restores all regions affected by that stroke.
- Height-range painting uses the native hit's world Z and configured height h,
  including applicable parts of the active object. Rotated parts do not rotate
  the band away from world Z.
- Gap-fill threshold changes preview destination colours without project or
  history changes. Apply commits all affected solid parts of the current object
  as one painting child entry; other session targets are unaffected. Preview and
  Apply agree for identical inputs, and empty results do not create history.
- Gap-fill multi-neighbour cases choose the lowest adjacent state, including
  state zero when present, consistently in preview and application.
- During an unfinished stroke, tool-type switches and camera rotation/pan/zoom have
  no effect and are not replayed after it ends. Live colour/erase/size changes
  remain available and must not inadvertently trigger a camera gesture.
- Cursor preview cannot affect native stroke targeting; native face selection
  remains correct with reordered renderer indices, mirrors, and
  nonuniform transforms.
- Dedicated mode does not invoke ordinary model drag/selection handlers.
- Part-based entry permits painting all solid parts of the owning object;
  entry requires at least two filament slots and hides all other instances.
- Reducing the slot count to one keeps an existing session open and paintable;
  closing it does not waive the two-slot requirement for reopening.
- Slot Delete/Merge with uses the project mapping for all affected annotations,
  including non-active objects, as one atomic history operation. Undo/Redo
  restores slots and painting together; compaction keeps this non-paint separator.
- Escape cancels an active stroke without closing or recording that stroke;
  idle Escape closes with completed strokes retained. Late events cannot revive
  a cancelled stroke.
- Save, Undo, Redo, explicit close, Preview, Slice, parameter-edit, and filament-
  slot commands issued during an unfinished stroke have no effect and are not
  replayed after release or Escape.
  Verify both shortcut and other command entry points, including no save dialog.
- Focus loss, pointer cancellation, and unexpected capture loss commit an
  effective unfinished stroke once and keep the gizmo open. Empty strokes do not
  create history; late input and ordinary capture release cannot duplicate the
  commit. Leaving the canvas with capture intact does not end the stroke.
- Each stroke commit and painting Undo/Redo updates native state and immediately
  invalidates obsolete results without eagerly recomputing heavy projections.
  Non-paint separators retain order and corresponding configuration/material state.
- Close compacts continuous runs, removes all redo when the effect condition
  holds, and completes deferred work without replaying committed strokes.
- A session with an effective commit clears Redo even after all its edits are
  undone; closure creates no empty painting entry. A session without effective
  commits preserves Redo, including when unfinished strokes were cancelled.
- Open-session Undo stops at session entry and leaves the gizmo open with Redo
  available. Earlier project operations become undoable only after closure.
- Save retains the open gizmo and child history without separating a paint run.
  Removing its saved node remaps the marker only to a known equivalent retained
  state; otherwise the project remains modified until saved again. Slice closes
  and settles required derived work before starting.
- Prepare-to-Preview closes the session; switching eligible objects preserves
  cross-object child history and does not split a paint run. Losing eligible
  selection closes normally. All touched targets remain covered at closure.
- Failed stroke commit or closure does not partially publish its state/history.
- 3MF round trips and actual multi-material slicing consume final native
  annotations; shared instances and affected plates remain consistent.
- Performance validation separates hit testing, selector work, draft geometry
  transfer, GPU updates, history memory, and final publication. No latency or
  memory target is considered measured or accepted yet.

## 10. Grouped clarification agenda

Resolve questions interactively, one important decision at a time, with pinned
Orca behavior and focused source evidence alongside each question. Update the
accepted sections after a coherent group is resolved; do not append a transcript
or create separate phase documents.

| Group | Important unresolved decisions |
| --- | --- |
| A. Editing target and lifecycle | Accepted: whole-object solid-part scope, two-slot entry gate, active-instance isolation, idle Escape closes, active-stroke Escape cancels that stroke and stays open, Save stays open, Slice and Preview close, eligible-object switches preserve the session, ineligible selection closes; active strokes ignore Save/Undo/Redo/explicit close/Preview/Slice without queuing; focus loss, pointer cancellation, and unexpected capture loss commit the current stroke and keep the gizmo open. Remaining: other activation gates, other pages, any whole-session discard, other active-stroke commands, export and destructive actions |
| B. History and external edits | Accepted: per-stroke native commits; any effective commit during the session requires all-Redo removal on close even if fully undone; no-effect sessions preserve Redo; Save does not separate painting runs; open-session Undo stops at session entry; conservative saved-marker remapping or unknown/modified fallback on compaction; active strokes ignore parameter and slot commands without queuing; single-slot sessions stay open; slot changes and painting remapping share the project policy and one atomic history operation. Remaining: other mutations during unfinished strokes |
| C. Multi-material tool behavior | Accepted: all six Orca tools required for the first release; Shift-left erasing plus an explicit panel mode and Erase all; colour/erase/size changes affect subsequent samples within one stroke/history entry; circle/sphere radii in mm; clipping, wireframe, vertical/horizontal restrictions, and gizmo remapping deferred; active strokes ignore tool-type switches and all camera navigation; region fill has native hover preview, continuous drag, and geometry-edge controls (initially enabled at 30 degrees, range 0-90); height range follows Orca's hit-world-Z plus h interaction; gap fill previews threshold changes, uses the lowest adjacent state, and applies to the current object's solid parts as one painting child entry. Remaining: shortcuts and camera bindings |
| D. Runtime and acceptance | Immediate invalidation with heavy derived work deferred until close or demand is accepted. Remaining: active slicing in serial/threaded mode; large-model budgets; input batching and display update policy; failures/recovery; fixtures and measurable acceptance gates |

No code implementation is authorized by this clarification workflow. Accepted
batches are integrated into the relevant sections. Continue resolving lifecycle
questions and fold each coherent batch into this same specification.
