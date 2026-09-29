# Surface Painting Architecture

**Date:** 2026-09-29

**Status:** Accepted architectural direction and clarified first-release behavior.
Implementation is in progress under the living plan. Quantitative performance thresholds remain to be
confirmed after initial reference measurements.

**Scope:** A shared surface-painting architecture for OrcaSlicerNeo, with
multi-material painting as its first gizmo and reusable foundations for support,
seam, and fuzzy-skin painting.

This is a major architecture specification alongside [Grand Plan](Grand%20Plan.md).
It is the single living record for this work, created directly in `spec/` at the
user's request. Accepted decisions below are binding; remaining measurement work
in section 10 does not imply an unmeasured performance guarantee. Clarifications
are folded into this document after a related group of questions has been resolved, rather
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

Application painting components and their tests live under
`packages/slicer-app/src/components/workspace/viewport/gizmo/painting/`.
`PaintingGizmoBase` owns shared interaction, cursor and display behavior;
`MmuPaintingGizmo` supplies the multi-material adapter, including filament colour
mapping. Directory ownership does not restrict the session owner's lifetime:
it remains mounted above the viewport so hiding or removing the viewport does
not close the session.

First-release input acceptance covers desktop mouse and trackpad click, drag,
and scroll interaction, with consistent behavior in Electron and desktop Web.
Dedicated touchscreen and stylus interaction, including pressure sensitivity,
are outside first-release acceptance requirements.

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

Brush radius, height-range size, fill-angle settings, and gap-area threshold
are retained in memory for the current application run. Closing/reopening the
gizmo or switching objects preserves these tool parameters; restarting the
application restores defaults. They are neither persisted user preferences nor
project data and do not participate in project history.

Retain the selected painting filament within the current project across gizmo
closure/reopening and object changes. Follow its logical material through slot
remapping rather than retaining a stale numeric index. If the resulting choice
no longer exists or lies outside the explicit painting palette, fall back to
slot 1. New projects and opening another project start with slot 1. This UI
selection is not saved in project files or recorded in project history.

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
live brush-size adjustments.

When no stroke is active, use Orca-style mouse navigation: left-drag on the
model paints, left-drag starting on empty space rotates, and Ctrl/Cmd plus
left-drag permits rotation even over the model. Middle/right drag pans, and
the unmodified wheel zooms. A gesture owned by camera navigation must not turn
into painting merely because the pointer subsequently crosses the model.

The first-release painting shortcuts are limited to Shift plus left button for
erasing and Ctrl/Cmd plus wheel to adjust the current tool's size or threshold.
Choose tools and filament colours through the panel; do not enable Orca's
C/S/T/H/F/G tool shortcuts or numeric filament-selection shortcuts. Deferred
auxiliary features have no active shortcuts. This limit concerns painting-tool
shortcuts, not already-defined Escape, Save, Undo/Redo, or camera modifiers.
Tool shortcuts must not take over text-input editing. Size/threshold wheel
adjustments must not also rotate or zoom the camera.

The Canvas, camera, and immutable source resources may be shared with Prepare;
dedicated mode does not require a second WebGL context. Draft display resources
remain separate from committed `GLVolume` paint resources. Closing returns to
ordinary Prepare rendering after the committed resources are ready.

### 3.1 Editing scope and entry condition

Selecting a part before opening the gizmo identifies its owning object; it does
not restrict painting to that part. All solid model parts of the target object
are eligible for painting. Modifiers and other non-model-part volumes are not
paint targets.

An otherwise eligible object remains paintable when marked non-printable or
positioned outside the printable area. Neither condition blocks painting entry
or requires an existing session to close. Participation in printing and placement
validity remain slicing concerns; the selection, filament, and runtime admission
conditions still apply.

Do not impose a fixed source-triangle-count threshold for first-release painting
admission. Measure representative models and document the verified performance
and memory range instead. Original face count alone does not bound selector
subdivision cost. This is not a guarantee of handling arbitrary model sizes;
the existing recoverable-failure and fatal-runtime policies still apply.

Multi-material painting requires at least two filament slots to open. This is
an entry-only gate: reducing the count to one during an open session keeps the
gizmo open and permits continued painting with the remaining slot. Do not reuse
the entry gate as an ongoing-session closure condition. Reopening after closure
still requires at least two slots.

The project retains its existing 64-slot capability, but the first-release
multi-material painter permits explicit painting only with slots 1 through 16,
matching Orca's supported facet-state range. Projects with more than 16 slots
may still open the gizmo; show an explanation and expose only the first 16 as
explicit paint choices. Do not extend the native painting format to 64 states
as part of this release. Unpainted state zero continues to resolve through the
part's effective project material assignment. Enforce the 16-state upper limit
at native write and remapping boundaries, not only in the palette. A slot
operation that would produce an explicit facet state greater than 16 after
remapping and renumbering is rejected atomically before applying any slot,
annotation, or history changes. Report the blocking painting reference; do not
clear painting or partially apply the operation to fit the limit. Check actual
affected explicit facet references: a project with more than 16 slots or an
unpainted part assigned to a higher slot is not itself an invalid paint state.

Painting mode displays only the active editing instance. Other objects and
other instances of the same object are hidden. The final annotations still
belong to the shared volumes and therefore affect the other instances too.

### 3.2 Explicit closure and Escape

When no stroke is active, Escape behaves like the toolbar close action:
retain the committed strokes, compact history, complete deferred updates, and
return to Prepare. It does not discard painting or ask whether to apply it.

Do not provide a whole-session discard action. Completed painting and interleaved
project edits are undone through history; Erase all is a new painting edit, not
a restoration of the state at session entry.

Only one gizmo may be open at a time. Numeric transform panels belong to their
respective gizmos and are not independent editing panels available alongside
painting. An idle switch to another gizmo first closes painting normally,
including history compaction and deferred updates, then opens the requested
gizmo. If painting closure fails, do not activate the other gizmo. During an
unfinished stroke, ignore gizmo-switch commands without queuing or opening the
other gizmo or its panel.

During an active stroke, Escape cancels only that stroke and keeps the gizmo
open. Restore the draft to its pre-stroke state and do not create a history
entry for the cancelled stroke. Earlier completed strokes and interleaved
non-paint edits remain intact. A subsequent Escape while idle performs normal
closure. Late samples or release events from the cancelled stroke must not
resume it or cause an implicit close.

While a stroke is unfinished, ignore Save, Export, Undo, Redo, explicit gizmo-close,
Prepare-to-Preview, user-initiated Slice, parameter-edit, and filament-slot
adjustment commands. Do not queue them, apply their project changes, open their
dialogs, commit or cancel the stroke, navigate history, or begin closure.
The user must issue the command again after the stroke finishes. Apply this
rule across shortcuts and other command entry points. Escape retains its
stroke-cancellation behavior above. If focus loss has already ended the stroke
before a parameter or slot command arrives, process it as an ordinary between-
stroke edit. Commands to delete the editing target or its parts, replace/reload
its mesh, or split it are also ignored during an unfinished stroke without
queuing. Their between-stroke policy is defined in section 7.4.

Apply the same unfinished-stroke gate to all other user-issued project mutation
commands, including model import, object duplication, automatic arrangement, and
plate addition/deletion, even when they appear unrelated to the current target.
Ignore them without executing, queuing, opening dialogs, or ending the stroke.
This is a command-admission rule, not a long-held native history transaction.
Live painting colour, erase state, and size adjustments remain available, and
Escape retains its active-stroke cancellation behavior. Between strokes, commands
resume their normal rules, including any required painting-session closure.

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
slicing. Returning to Prepare does not automatically reopen the gizmo.

Switching to Home, Device, or another non-Preview page keeps the painting session
hidden rather than closing it. Preserve the session and expanded child history;
returning to Prepare resumes that same session. Hiding alone does not compact
history or run closure-only work. The session must outlive the viewport/page
component if navigation unmounts it. Project replacement and application shutdown
are separate operations, not ordinary page navigation.

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
for a later valid selection.

During an unfinished stroke, ignore commands to switch or clear the editing
selection and to navigate to Home, Device, or another page, without queuing.
Preserve the current target, page, and stroke; the user must repeat the command
after the stroke ends. Preview is also covered by section 3.2. If an independent
focus-loss event already ended the stroke before a selection/navigation command
arrives, process that command under the normal idle rules above.

## 4. Cursor preview and authoritative native picking

The React-side BVH is used only to locate the cursor visually on the original
model. Its hit point, `faceIndex`, and selected hit volume do not determine a
painting operation. No BVH is built over the subdivided paint display geometry.

Once the pointer is pressed, native code performs all painting hit tests and
face identification. The frontend sends the admitted pointer events in order and the
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
a newer session. Each admitted painting event carries the colour, erase state,
and size applicable when admitted; later UI changes cannot retroactively alter
an in-flight event. Live settings affect subsequent admitted events within the
same stroke. Event admission and termination follow section 4.2; the exact
camera-snapshot transport remains an implementation-design detail to finalize.

### 4.1 Draft geometry publication and refresh scheduling

The first release publishes complete replacement display geometry for each
changed solid part/volume. Unchanged parts retain their existing display
resources. Triangle or patch deltas, stable display-triangle identities, and
incremental topology synchronization are not required for the first release;
consider them later if measured generation, transfer, or upload costs justify
the additional protocol and resource-lifetime complexity.

During continuous painting, request geometry refreshes in step with display
frames when there are pending changes and the preceding refresh has completed.
There is no fixed 30 Hz cap. Do not accumulate a queue of complete geometry
refreshes: coalesce pending display requests and publish the latest eligible
state. This is a scheduling policy, not a guarantee of achieving the display's
refresh rate on every model or device. Cursor and camera rendering remain
independent of the geometry-publication cadence.

Geometry-refresh coalescing applies only to intermediate display states; it must
not discard admitted painting events or stroke boundaries. Separately, movement
events arriving during an in-flight painting event are discarded under section
4.2. Stroke completion,
cancellation, and history navigation must converge to their resulting native
state even if intermediate previews were skipped. Session and revision checks
reject obsolete output so a delayed replacement cannot overwrite that state.
This display policy does not change per-stroke commits or their history semantics.

### 4.2 One-event processing and reliable stroke termination

Process only one painting input event at a time. While that event is in flight,
discard subsequent pointer-move events at admission. Do not buffer, queue, batch,
retain the latest pending move, or replay these discarded events when processing
finishes. Once idle, admit the next eligible event that actually arrives. Native
trajectory interpolation remains authoritative between admitted positions; it
cannot reconstruct a discarded intermediate path. This policy supersedes the
earlier requirement to preserve every movement event.

Only intermediate movement events may be dropped by this busy-event policy.
Pointer release and other stroke-ending signals must be retained and take effect
even while native processing is busy. Record the stroke's pending terminal state,
stop accepting further movement for it, then perform the corresponding end action
after the in-flight native call returns. This is a bounded lifecycle state, not a
queue of drawing events. Preserve the established distinction: normal release and
unexpected focus/capture loss or pointer cancellation commit the effective portion;
Escape cancels and restores the pre-stroke state. Deduplicate terminal signals
and reject late results/events so finalization occurs once. Existing ignored-command
and fresh-press rules still apply; this does not authorize queuing new strokes.

For Escape during an unfinished stroke, immediately stop accepting its input and
show cancellation in progress. First-release cancellation takes effect between
native calls; do not require interruption inside a synchronous selector algorithm.
After the current call returns, restore the pre-stroke selectors/display without
creating history, then permit a new stroke. Until restoration completes, do not
admit a new stroke. Do not terminate the Worker to interrupt this call. A slow
native call can therefore delay completion of cancellation.

Normal pointer release retains its position and corresponding input context as
part of the terminal event. After any in-flight event completes, native code
processes that position as the final painting sample before committing the stroke,
using the same authoritative hit testing and tool semantics. This final sample is
not dropped by the busy-move policy and is not a queued intermediate move. It
belongs to the same stroke and creates no separate history item. Capture its live
tool settings at release rather than reading later UI state during finalization.
Escape cancellation does not perform this final painting sample. Unexpected
focus/capture loss or pointer cancellation commits the effective portion under
the existing policy without inventing a normal-release position.

## 5. Per-stroke commits and deferred derived updates

Only the active, unfinished stroke is a draft. At pointer release, wait for its
in-flight event and native stroke finalization, atomically write the changed native
annotations to the live model, and record one navigable child history operation.
While native event processing/finalization or the commit is pending, show a
processing state and do not admit another stroke. Ignore new presses rather than
queuing them; after successful
completion the user must press again to start a new stroke. Do not implicitly
begin painting from a button held during this waiting period.

For a recoverable commit failure with a healthy Worker and intact authoritative
project state, roll back any partial transaction, automatically discard this
stroke's draft, restore selectors/display to the pre-stroke state, and report
the failure. Earlier committed edits and history remain intact. Once recovery
is complete, allow a new stroke; do not retain a failed-draft Retry workflow.
An empty stroke creates no history entry. Closing the gizmo does not write the
completed strokes again.

A fatal Worker OOM or WASM trap follows the existing shared runtime fatal-error
flow, as required by the project persistence and multi-filament specifications.
Painting does not introduce a separate Worker-recovery protocol or autosave,
and cannot promise reconstruction of unsaved native state. Nested painting
history remains in-memory only, consistent with Undo and Redo.

Immediately after each effective commit, advance the affected slice-input
versions and make obsolete slice results unusable. Heavy derived work,
including material-use summaries and Prime Tower projections, is deferred until
gizmo closure or an operation actually requires it. Deferred work must not make
an obsolete cache or slice result appear current. Existing slice jobs and
runtime admission follow section 7.5.

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
stroke are ignored under section 3.2, as are the target-changing commands listed
there. Other project mutations during a stroke remain to be clarified.

### 5.1 Working-memory policy

The first release adds no painting-specific hard byte limit for selectors,
subdivision data, draft display geometry, or transfer buffers. This does not
exempt history from its separate project budget or remove existing runtime and
device resource limits. Release superseded display resources and temporary
buffers promptly, measure peak working memory on representative models, and
report the actually validated range. Recoverable allocation/operation failures
and fatal runtime failures follow the policies above; do not promise that every
allocation failure can be detected or recovered before the runtime fails.

## 6. Nested history and compaction

### 6.1 Expanded session history

Use nested history with navigable child edits while the gizmo remains open.
Individual strokes are undoable only during that open session. Non-paint
project mutations participate in the same chronological order rather than in
an unrelated paint-only undo stack.

While the gizmo is open, Undo cannot navigate before session entry, including
through a history-jump UI. History eviction may move the oldest reachable state
forward within the session; opening the gizmo does not guarantee that every stroke
remains available until closure. Reaching the retained boundary keeps the gizmo
open and permits retained Redo navigation. The user must close the session before
undoing any still-retained earlier project operations; normal closure compaction
and conditional Redo removal still apply.

The session is a history container, not a long-held instance of the current
exclusive native transaction. Individual commands still require atomic,
serialized execution through the project mutation coordinator. The existing
coalesced child transaction merely joining its parent is insufficient: the new
history capability must retain child states for navigation and non-paint edits
as independent boundaries.

### 6.2 Collapse continuous paint runs on close

On closure, each retained continuous run of painting edits collapses to one semantic
history operation. Every intervening effective non-paint project operation
separates runs and retains its own history identity while retained. Compaction
does not resurrect evicted operations or their earlier states, or merge across
non-paint operations.

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

### 6.5 Shared history budget and eviction

Expanded painting children and interleaved non-paint operations share the existing
per-project history budget from Undo and Redo: 256 MiB by default. An open painting
session is not exempt from oldest-first eviction and has no separate unlimited
history store. The current state and most recent usable Undo/Redo path remain
protected under that specification, including its exception for a single atomic
entry larger than the normal budget.

Eviction can remove early strokes before the gizmo closes. The oldest reachable
state then advances, and closure compacts only the retained portion of each paint
run. Do not retain hidden copies of evicted children to reconstruct the original
session on closure. Non-paint boundaries must remain respected, and eviction must
not reset the session-lifetime effective-commit condition used for Redo cleanup.
Apply the existing saved-marker and resource-diagnostic rules; eviction does not
create a new disruptive notification or automatically close the gizmo.

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
Already-running slice work follows section 7.5.

### 7.3 Closure publication

Closing validates the session and compacts the already-committed history without
replaying model mutations. Complete deferred painting-related calculations for
the affected objects and plates, including other instances sharing the edited
annotations. Ordinary Prepare resources become visible only when they match
the committed state. Do not repeat invalidations or calculations already settled
for the same input version.

Active-stroke Escape cancellation and ignored commands are defined in section
3.2, including single-gizmo switching and the absence of a whole-session discard
action. Project replacement and normal application shutdown follow section 7.6.
Export follows section 7.7.

### 7.4 Target deletion and mesh-changing commands

With no unfinished stroke, commands that delete the editing object or its parts,
replace/reload its mesh, or split it first close the painting gizmo normally.
Retain completed edits, compact history, apply the conditional Redo cleanup,
and release native editing resources before executing the model operation.
The model operation retains its own history entry rather than being merged into
a painting run. If closure fails, do not execute it against the open session.
During an unfinished stroke, ignore these commands without queuing as specified
in section 3.2.

### 7.5 Existing slice jobs and runtime admission

In threaded WASM, opening the painting gizmo does not cancel an existing slice
job. Hover and tool-setting changes do not invalidate it. An effective painting
commit invalidates results for the affected plates and requests cancellation of
an in-flight job if its plate is affected; jobs for unaffected plates continue.
Use the existing plate input-version and task-identity checks so obsolete job
completion cannot publish a current result. Painting edits do not automatically
start replacement slicing jobs, consistent with Per-Plate Print Architecture.

Serial WASM retains that specification's editing admission gate: while a slice
occupies the sole Worker, painting cannot open or issue native editing commands.
Wait for the slice's normal terminal state before admitting painting; there is
no serial Cancel operation and no Worker termination workaround that would
discard the live project and history. Rejected editing requests do not form a
queue to execute automatically after slicing.

### 7.6 New/Open project and normal application exit

With no unfinished stroke, New/Open project and normal application-exit commands
run their existing file-selection and unsaved-project confirmation flow before
ending the painting session. Cancelling a file picker, the project confirmation,
or a requested save keeps the existing painting session and expanded child
history; do not close or compact merely because the command was invoked. A
successful save can still advance its normal saved marker without compaction.

Only once the user elects to continue and any requested save succeeds should
the session end and the confirmed project-lifecycle operation proceed. Apply
the existing New/Open/exit project and history lifetime rules, including when
the painting session is hidden on another page.

During an unfinished stroke, ignore these commands without queuing or opening
their file/confirmation dialogs. The user must repeat the command after the
stroke ends. This concerns normal user commands the application can intercept;
forced process termination is governed by the fatal-error/persistence boundary,
not this navigation protocol.

### 7.7 Export

With no unfinished stroke, exporting keeps the painting session open and its
child history expanded. Export reads committed state and settles only the
deferred calculations required by that export. It does not compact history or
separate consecutive painting edits merely because an export occurred.
Existing export/save semantics continue to determine saved-state markers.

G-code export remains subject to the selected plate's valid slice-result stamp
under Per-Plate Print Architecture. Keeping the gizmo open does not authorize
exporting an invalidated result or implicitly starting a new slice. During an
unfinished stroke, ignore Export without queuing, opening a dialog, or ending
the stroke. This policy adds no export formats or command entry points.

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
- Tool parameters survive gizmo closure/reopening and object changes within
  the application run, reset on restart, and never enter project persistence or
  history. Projects above 16 slots can open painting, with explicit paint choices
  restricted to slots 1-16 and an explanation of that restriction.
- The selected painting filament survives same-project closure/reopening and
  object changes, follows slot remapping, and falls back to slot 1 when no longer
  selectable. New/opened projects start at slot 1 without a history mutation.
- Native writes reject explicit paint states above 16. Slot remapping validates
  the final renumbered references and rejects an unsupported result atomically,
  preserving all annotations, slots, and history. State-zero inheritance from a
  higher project slot remains valid.
- Circle and sphere brush radii use mm and preserve physical coverage under
  camera zoom; cursor display and native selection agree on transformed objects.
  Deferred auxiliary features are not first-release acceptance requirements.
- Colour, erase state, and brush size changes affect subsequent admitted events in
  the same stroke. In-flight events retain their admitted settings, and Undo/Redo
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
- Idle camera gestures follow the specified left/modified-left rotation and
  middle/right pan mapping. A camera-owned gesture cannot start painting on
  entering a model. Tool and filament letter/number shortcuts remain disabled;
  supported erasing/parameter shortcuts do not interfere with text entry or
  simultaneously operate the camera.
- Cursor preview cannot affect native stroke targeting; native face selection
  remains correct with reordered renderer indices, mirrors, and
  nonuniform transforms.
- At most one painting event is in flight. Move events received while busy are
  discarded with no pending-latest move or replay. Stroke-ending signals survive
  that busy period and finalize once with their specified commit/cancel semantics.
  Escape stops admission immediately, restores state after the current native call,
  and admits no new stroke until cancellation completes; late output cannot revive
  the cancelled draft.
- A normal release received while busy retains its position/context, processes
  one final native painting sample after the in-flight event, and then commits
  once. The final sample uses release-time settings and remains in the same
  history entry. Escape does not paint the release endpoint.
- Dedicated mode does not invoke ordinary model drag/selection handlers.
- Desktop mouse and trackpad click/drag/scroll behavior is consistent across
  Electron and desktop Web; dedicated touch, stylus, and pressure acceptance is
  deferred.
- Draft geometry replaces only changed parts in full. Refreshes follow display
  opportunities with one refresh in flight, without a fixed 30 Hz cap or a queue
  of obsolete refreshes. Coalescing display states preserves admitted painting events;
  completion, cancellation, and Undo/Redo display the correct final state and
  reject late output. No measured frame-rate guarantee is implied.
- Part-based entry permits painting all solid parts of the owning object;
  entry requires at least two filament slots and hides all other instances.
- Non-printable flags and out-of-bounds placement do not prevent otherwise
  eligible painting or force session closure; slicing validation remains intact.
- Painting admission has no fixed source-triangle-count cutoff. Performance
  reports state the model/device range actually verified rather than promising
  arbitrary-size support.
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
- Other project mutation commands, including import, duplication, arrangement,
  and plate changes, are also ignored during unfinished strokes even for unrelated
  targets, with no dialog, queued action, or implicit stroke termination. Live
  paint settings and Escape keep their explicitly defined behavior.
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
  available, or stops at a later retained boundary after budget eviction. Earlier
  retained project operations become undoable only after closure.
- Expanded painting children share the project history byte budget and can be
  evicted oldest-first. Preserve the existing oversized-single-entry exception.
  Closing compacts only retained history, never revives evicted records, and
  preserves non-paint separators and the session's effective-commit condition.
- Save retains the open gizmo and child history without separating a paint run.
  Removing its saved node remaps the marker only to a known equivalent retained
  state; otherwise the project remains modified until saved again. Slice closes
  and settles required derived work before starting.
- Prepare-to-Preview closes the session; switching eligible objects preserves
  cross-object child history and does not split a paint run. Losing eligible
  selection closes normally. All touched targets remain covered at closure.
- Home/Device page navigation hides and resumes the same session without
  compaction, including across viewport unmount/remount. During a stroke,
  selection changes/clearing and page-navigation commands are ignored without
  queuing; they cannot implicitly switch the target or hide an unfinished stroke.
- Cancelling New/Open/normal-exit file or confirmation dialogs retains the open
  or hidden session and expanded history. Confirmed continuation ends it only
  after any requested save succeeds. These commands during a stroke are ignored
  without queuing or opening dialogs.
- Failed stroke commit or closure does not partially publish its state/history.
- Only one gizmo and its associated numeric panel are active. Idle switching
  closes painting normally before activating another gizmo; closure failure
  prevents activation. During a stroke, switching is ignored without queuing.
  No whole-session discard action is exposed.
- Idle Export retains the session and expanded history and reads committed
  state, settling only required derived data. It does not separate painting
  runs. Active-stroke Export has no effect or dialog and is not queued; G-code
  export cannot bypass selected-plate result validity or implicitly slice.
- Pending stroke processing/commit displays a processing state and rejects new
  strokes without queuing. Success requires a fresh press for the next stroke.
  Recoverable failure automatically discards the failed draft, restores its
  pre-stroke display/model/history state, reports the error, and permits new
  strokes after recovery. Fatal Worker failure uses the shared runtime flow.
- Idle target deletion, replacement/reload, and splitting close and compact the
  painting session before model mutation, retaining a separate model-operation
  history entry. During a stroke these commands are ignored without queuing.
- Threaded gizmo entry preserves active slicing; effective commits cancel only
  affected-plate jobs and reject their stale results. Serial slicing rejects
  painting admission without queuing or terminating the Worker.
- 3MF round trips and actual multi-material slicing consume final native
  annotations; shared instances and affected plates remain consistent.
- Performance validation separates hit testing, selector work, draft geometry
  transfer, GPU updates, history memory, and final publication. No measured latency
  or peak-memory result is claimed yet. Painting adds no dedicated working-memory
  hard cap; history retains its separate byte budget. Verify cleanup of replaced
  geometry and temporary buffers across repeated edits and session closure.

### 9.1 Reference environment and benchmark corpus

Use the current Windows development machine for the first performance baseline.
Record its CPU, memory, GPU, operating system, browser/Electron versions, source
revisions, and build/runtime configuration when measuring. Measure Electron and
desktop Web separately and compare with pinned native Orca on the same machine
and fixed models/operations. A result on this reference machine is not a minimum
supported hardware specification or a guarantee for other devices.

Combine reproducibly generated models with a small fixed set of real projects.
Generated cases vary original triangle count, solid-part count, and painting
subdivision density independently where practical. Reuse existing painted-facet
fixture coverage, then add the cases needed for editing. Real projects complement
these controlled cases with representative production geometry. Keep fixture
generation/acquisition, versions, and operation scripts reproducible through the
repository; select and record exact cases during implementation.

Cover all six tools, continuous painting, normal release and Escape completion
latency, Undo/Redo, and session-close compaction. Record hit-testing and selector
time, draft geometry generation/transfer/upload costs, visible refresh cadence,
peak working memory, retained history size, and resource cleanup. Because busy
movement events are intentionally dropped, also record admitted/dropped movement
counts and completion of reliable terminal events. Distinguish comparisons of
equivalent admitted input sequences from end-to-end interaction runs; reduced
work from dropping input must not be reported as an equivalent-work speedup.

First establish the measured baseline, then review and confirm numeric latency
and other performance acceptance thresholds from those results. Do not invent
fixed frame-rate, latency, or working-memory guarantees before measurement. This
does not waive functional correctness, reliable stroke termination, atomic
history/model behavior, or resource-lifetime verification in section 9. No fixture
generation, benchmark execution, or implementation is claimed by this document.

## 10. Decision status and remaining validation

The grouped clarification of first-release product behavior and architectural
boundaries is complete. Accepted decisions are maintained in their relevant
sections rather than as a discussion transcript.

| Group | Status |
| --- | --- |
| A. Editing target and lifecycle | Accepted; sections 3 and 7 define eligibility, single-gizmo ownership, navigation, closure, and external commands. |
| B. History and external edits | Accepted; sections 5-7 define per-stroke commits, nested navigation/compaction, eviction, Redo cleanup, and interleaved project changes. |
| C. Multi-material tools | Accepted; sections 2-4 define all six tools, their parameters and lifetime, desktop input, native authority, and reliable event completion. |
| D. Runtime and acceptance | Runtime policies and the measurement plan are accepted; sections 4-6 and 9 define event admission, cancellation, memory policy, reference environment, and fixtures. Numeric performance thresholds await the first measured baseline and subsequent review. |

Implementation must still specify concrete protocol schemas, camera-snapshot
transport, module changes, and reproducible fixture/benchmark commands within
these accepted boundaries. These engineering details do not authorize changing
product semantics or claiming measurements that have not been made. If further
important product choices arise, clarify them interactively with pinned Orca
behavior and source evidence, then update this specification in coherent batches.

Implementation was authorized on 2026-09-29 on the current development branch.
The [living implementation plan](../doc/2026-09-29-surface-painting-implementation.md)
defines bounded sequential steps, each implemented and self-verified by a fresh
subagent and independently accepted by the parent before the next step starts.
This specification does not itself claim implementation, runtime validation, or
a delivered roadmap milestone.
