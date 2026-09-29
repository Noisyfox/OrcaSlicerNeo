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
   compaction, and final publication.
4. Annotation adapters: native field, legal states, display semantics, response
   to external edits, and effects of final publication.

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

## 3. Dedicated painting mode

Opening a painting gizmo changes the viewport to a dedicated drawing and input
mode. It must not layer editing on the ordinary Prepare model/body-drag path.

The painting mode owns selector-derived draft surfaces, cursor rendering,
candidate-region highlighting, and any enabled contours, wireframe, or clipping
presentation. Ordinary object selection, body dragging, box selection, and
transform gizmo handlers do not compete for its painting gestures. Camera
navigation remains a separate interaction.

The Canvas, camera, and immutable source resources may be shared with Prepare;
dedicated mode does not require a second WebGL context. Draft display resources
remain separate from committed `GLVolume` paint resources. Closing returns to
ordinary Prepare rendering after the committed resources are ready.

Exact editable target scope, isolation of other objects/instances, camera
bindings, and mode-entry/exit actions remain subject to section 10 clarification.

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
Any fill-candidate hover query is native as well; cursor hits are not an input
authority for fill selection.

Input and output carry session/order identity so late responses cannot overwrite
a newer session. Releasing a stroke waits for all accepted samples belonging to
that stroke. Precise batching, backpressure, camera-snapshot transport, and
cancellation behavior are to be finalized before implementation.

## 5. Session drafts and deferred effects

Every painting operation remains a draft for the entire time the gizmo is open.
Ending a stroke records a child history state; it does not publish painting to
the live model. Undo/Redo of painting changes the draft and painting display.

Painting must not cause the following before final gizmo closure:

- Replacing the ordinary committed paint display resources.
- Recomputing committed material-use summaries or Prime Tower projections.
- Advancing plate slice-input stamps or invalidating/cancelling slice work.

Computing draft geometry, candidate regions, and the cursor remains necessary
for the editing display and is outside that deferred-effects restriction.

Non-paint project operations may occur while the gizmo is open. They retain
their own semantics and effects; they must not implicitly commit preceding
painting drafts or include those drafts in committed derived-state calculation.
Their exact interaction with live jobs and read/export operations is an open
lifecycle topic.

## 6. Nested history and compaction

### 6.1 Expanded session history

Use nested history with navigable child edits while the gizmo remains open.
Individual strokes are undoable only during that open session. Non-paint
project mutations participate in the same chronological order rather than in
an unrelated paint-only undo stack.

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
or split a paint run. Empty strokes do not create entries. Closing removes the
stroke-level granularity; reopening must not resurrect those child nodes.

Recording or compacting history is distinct from publishing model state.
Compaction must not replay intermediate states through the live model and
trigger repeated derived-state updates.

### 6.3 Redo on closure

Closure uses the current history cursor, never an automatically redone state.
If this gizmo operation has produced an effect, successful closure discards
**all Redo**, including paint children, non-paint redo operations, and any
previously retained redo branch. No redo branch is compacted and retained in
that case.

Final model publication, history compaction, and redo removal must be atomic.
Failure retains the draft and navigable history so the user can continue or
retry. The exact effect/no-effect predicate, including fully undone edits,
requires clarification; it must not be silently inferred from pointer activity.

### 6.4 State ownership

History must preserve the pairing of project state and paint draft at each
interleaved edit. Use native, stable-identity state ownership and shared immutable
mesh resources; display geometry is not the history authority. Final compacted
entries must restore correct annotation/configuration combinations without
retaining a closed editing session or its stroke-level nodes.

The concrete draft checkpoint representation and conversion to committed
history roots remain an implementation design topic. The behavior above must
be proved independently of viewport rendering.

## 7. External edits and final publication

Global/scoped configuration and filament-slot operations can separate paint
runs without closing the session. Slot operations must keep current draft
references meaningful; palette changes affect display, while deletion, merging,
or reordering requires coordinated native state mapping. Historical nodes must
remain paired with their historical material definitions. Exact slot-remapping
and failure policies remain to be clarified.

Closing drains the accepted stroke input, validates the session, prepares the
final annotations and compacted history, and publishes them atomically. Only
the final current state is applied to the live model. Painting-related derived
state is then updated for the affected objects and every affected plate,
including other instances sharing the edited annotations. Ordinary Prepare
resources become visible only when they match that committed state.

The session draft is retained on failure. The treatment of pending input,
explicit cancel, source-mesh replacement, target deletion, Save, Slice, export,
page changes, and application shutdown is deliberately not settled here.

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

Orca writes selector results back at stroke release. Neo intentionally differs:
all painting remains draft until gizmo closure, while preserving the requested
session history and compaction semantics. wx/ImGui/OpenGL classes are references,
not components to compile into the WASM application.

## 9. Required validation themes

- Cursor preview cannot affect native stroke targeting; native face selection
  remains correct with reordered renderer indices, clipping, mirrors, and
  nonuniform transforms.
- Dedicated mode does not invoke ordinary model drag/selection handlers.
- Stroke Undo/Redo changes draft only; non-paint separators retain order and
  corresponding configuration/material state.
- Close compacts continuous runs, removes all redo when the effect condition
  holds, and publishes painting-related effects only once per affected target.
- Failed finalization preserves the open draft/history and committed state.
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
| A. Editing target and lifecycle | Whole-object versus selected-part scope; activation gates; isolation; target switches; close, Escape, and cancel; Save/Slice/export and destructive actions |
| B. History and external edits | Effect/no-effect and fully undone sessions; no-effect redo behavior; navigation across the session boundary; dirty/save semantics; slot-remapping atomicity; other mutations interleaved with drafts |
| C. Multi-material tool behavior | Initial delivery scope; brush shapes and units; fill and erase semantics; clipping, height range, gap fill, remapping, shortcuts, camera and pointer cancellation |
| D. Runtime and acceptance | Active slicing in serial/threaded mode; large-model budgets; input batching and display update policy; failures/recovery; fixtures and measurable acceptance gates |

No code implementation is authorized by this clarification workflow. The next
step is to settle group A, then fold its decisions into this same specification.
