# Scene-owned Multi-volume Selection Design

Date: 2026-08-18
Status: Approved — 2026-08-18
Scope: Next step after Milestone 6. Refactor renderer interaction state so the
scene owns selection, gizmo state, and drag state; make move operations work on
the whole selection.

## Goal

Replace the current single-volume selection (`selectedVolumeId`) and per-mesh
gizmo / drag state with a scene-owned selection that may contain multiple
renderer `GLVolume`s. A body drag and the one currently open gizmo operate on
the whole selection, preserving each member's relative position.

This is a renderer-only interaction refactor. `Slic3r::Model` remains unchanged
while a gesture is active and is synchronized only at the existing pre-slice
boundary.

## Findings from the native OrcaSlicer canvas

The C++ implementation provides the reference behavior:

- `GLCanvas3D` owns both `m_selection` and `m_gizmos`, and gives `Selection` a
  pointer to its `GLVolume` collection. Selection is therefore canvas-local,
  rather than a global model or sidebar concern.
- `Selection` stores a set of selected GL-volume indices, not one current
  item. It derives aggregate content and a world-space bounding box from that
  set, then caches selected transforms and the drag center at gesture start.
- Its normal mode is **Instance**. Selecting one render volume selects every
  GL volume for the same `(objectIdx, instanceIdx)`. Its **Volume** mode is a
  separate part-editing mode that applies `ModelVolume` transforms and keeps
  corresponding render copies synchronized.
- `GLCanvas3D` starts a move only after the hit volume belongs to the current
  selection, calls `Selection::setup_cache()` at gesture start, and applies the
  displacement to the complete selection on every pointer update.
- `GLCanvas3D::do_move`, `do_rotate`, and `do_scale` commit the resulting
  renderer transforms to the C++ model. Instance mode writes
  `ModelInstance::set_transformation`; volume mode writes
  `ModelVolume::set_transformation`. Native gizmo management has one current
  gizmo at a time.

The existing Electron renderer has composite identity and deferred bridge
synchronization already, but differs in the three relevant ways:

- `useSettingsStore.selectedVolumeId` holds only one ID.
- Every `GLVolumeMesh` owns a `DragControls`, a gesture ref, React gesture
  state, and conditionally renders its own `MoveGizmo`.
- The move panel and legacy per-object position maps derive their target from
  that single selected ID. They cannot express a group pivot or a multi-volume
  reset/drop operation.

## Proposed renderer model

### Identity and selection mode

`VolumeId` remains the stable composite string
`"objectIdx:volumeIdx:instanceIdx"`. A new renderer-only `Selection` type
holds an ordered set of these IDs and has no dependency on Zustand or the WASM
client.

```ts
type VolumeId = GLVolume['id'];
type SelectionMode = 'instance';

class Selection {
  readonly mode: SelectionMode;
  readonly ids: ReadonlySet<VolumeId>;

  replaceFromHit(hit: GLVolume): void;
  toggleFromHit(hit: GLVolume): void;
  clear(): void;
  prune(existing: Iterable<GLVolume>): void;
  has(volume: GLVolume): boolean;
  volumes(collection: readonly GLVolume[]): GLVolume[];
  instanceKeys(): ReadonlySet<InstanceKey>;
}
```

For this milestone, the default mode is the native default, `instance`:

1. A hit on any GL volume resolves its complete `(objectIdx, instanceIdx)` set.
2. A normal click replaces selection with that set.
3. Ctrl/Cmd-click toggles that complete set, enabling multiple instances (and
   therefore multiple GL volumes) to be selected. Shift remains reserved for
   future box selection and is not an additive-selection modifier.
4. A click on empty bed clears selection when it did not become a drag.

This deliberately prevents an inconsistent state in which only one render
copy of a shared `ModelInstance` has a changed `instanceTransform`. It also
matches the existing move bridge behavior, which groups instance transforms by
`(objectIdx, instanceIdx)` before slice synchronization.

Part/volume selection is deferred only as a follow-up interaction. `Selection`
is designed to support a future modifier key that switches the hit expansion
key to `(objectIdx, volumeIdx)`, changes the operation target to
`volumeTransform`, and preserves the existing pre-slice consistency check for
all instances of that model volume. The specific modifier is intentionally not
assigned by this milestone, so it cannot conflict with Ctrl/Cmd multi-select
or Shift box selection.

### Scene ownership

`Scene` creates one `SceneInteractionController` for its lifetime and provides
it to child viewport components through a React context. Its state is:

```ts
interface SceneInteractionState {
  selection: Selection;
  openGizmo: 'move' | null;
  drag: null | {
    kind: 'body' | 'gizmo';
    startPivot: THREE.Vector3;
    startInstances: ReadonlyMap<InstanceKey, ModelTransform>;
  };
}
```

`SceneInteractionController` is constructed by `Scene` and is the single
mutation API for selection and interaction. It emits a small version change
for React rendering; GLVolume transforms themselves remain in
`glVolumeCollection` as the renderer's local project state. The containing
viewport forwards the Scene-owned controller reference to sibling toolbar and
sidebar command components, but never constructs or retains it across a Scene
unmount. Loading a new model clears the controller, closes the gizmo, and
prunes any stale IDs before exposing new geometry.

`useSettingsStore` no longer owns `selectedObject`, `selectedVolumeId`,
`positions`, `initialPositions`, `objectMinZ`, or drag/gizmo state. Sidebar
command components receive the Scene-owned controller reference through the
viewport composition boundary. Slicer state, presets, and print-option values
remain in their existing stores.

### One gizmo and one gesture

Only `Scene` renders `<MoveGizmo>`, once, when all of these are true:

- the selection is non-empty;
- `openGizmo === 'move'`; and
- no body drag is active.

The gizmo attaches to a non-rendering scene-owned pivot group positioned at
the selection's aggregate world bounding-box center. `openGizmo` is a single
nullable value, so opening a different future gizmo replaces/clears the
previous one by construction. Individual `GLVolumeMesh` components never
render a gizmo.

Body-drag wrappers may remain close to their meshes for hit testing, but their
callbacks only ask the scene controller to begin, update, or end a body drag.
They own no gesture ref, no React gesture state, and no transform commit path.
The controller rejects a body drag while a gizmo drag is active and rejects a
gizmo drag while a body drag is active.

### Pointer arbitration: gizmo grabbers win

`TransformControls` grabbers have strict priority over `DragControls`. A press
on an axis, plane, or center grabber must never start a body drag, even when
the same screen pixel also intersects a selected model mesh.

The scene controller owns a synchronous mutable `pointerOwner` gate in
addition to its renderable interaction state:

```ts
type PointerOwner = 'none' | 'gizmo' | 'body';
```

The interaction sequence is:

1. The viewport's native pointer-capture handler synchronously asks the live
   `TransformControls` picker whether a grabber is under the press, before any
   `DragControls` target callback, and latches that result for the whole
   pointer press. A press that begins outside a grabber remains a body-eligible
   press even if the cursor reaches a grabber before `DragControls` crosses its
   movement threshold. `MoveGizmo` then claims
   `pointerOwner = 'gizmo'` on the confirmed grabber press, before recording
   the gizmo drag snapshot.
2. Every `GLVolumeMesh` only enables / begins `DragControls` when no gizmo
   grabber is under the pointer. Its `onDragStart` must also call
   `tryBeginBodyDrag()`; this final synchronous gate rejects the drag if the
   gizmo has already claimed the press.
3. `DragControls` uses `autoTransform={false}` and its update callback is
   guarded by `pointerOwner === 'body'`. Thus an event propagated from a gizmo
   press cannot mutate a mesh even in the render-cycle race between the
   gizmo's synchronous claim and React updating `dragConfig.enabled`.
4. Pointer release, cancellation, selection replacement, or selection clear
   releases the owner and restores orbit controls. Exactly one controller end
   path commits the resulting local scene state.

This is intentionally redundant: disabling `DragControls` for a hovered
grabber gives the expected behavior, while the synchronous ownership and
update guards protect against r3f / drei event propagation and stale prop
timing. Tests must exercise a handle press whose ray also hits a mesh and
prove that only the gizmo operation changes transforms.

### Applying a move to the selection

At body-drag or gizmo start, the controller captures:

- the aggregate selection pivot; and
- the complete `instanceTransform` for each distinct selected
  `(objectIdx, instanceIdx)`.

Each pointer update computes one world-space translation delta from that fixed
start state. The controller applies that delta to every captured instance
transform and propagates it to all GLVolume render copies of that instance.
The selection pivot moves by the same delta. This preserves the spacing among
selected instances and leaves nonselected instances unchanged.

No operation sends a worker request during the gesture or on release. The
existing toolbar pre-slice loop remains the sole C++ synchronization boundary.
Because every GL volume of each changed instance receives the same transform,
the existing bridge grouping invariant remains valid.

### Move panel semantics

The move panel is selection-driven rather than volume-driven:

- with one or more selected instances, X/Y/Z display the aggregate selection
  pivot in world coordinates;
- editing one coordinate translates every selected instance by the difference
  between the new and current pivot coordinate;
- **Drop to bed** translates every selected instance by the amount that puts
  the aggregate selected world bounding box's minimum Z at zero; and
- **Reset** restores every selected instance to its load-time instance
  transform, including all renderer copies for that instance.

This makes panel, body drag, and gizmo use the same group-operation path.

## Component boundaries after the refactor

```text
Viewport composition boundary
├─ Scene
│  ├─ glVolumeCollection (renderer project state; existing)
│  ├─ SceneInteractionController
│  │  ├─ Selection (many VolumeIds, instance-expanded)
│  │  ├─ openGizmo (zero or one)
│  │  └─ drag snapshot (zero or one)
│  ├─ GLVolumeMesh × N
│  │  ├─ renders selected styling via controller.selection.has(data)
│  │  └─ forwards click/body-drag events to controller
│  └─ MoveGizmo × 0..1
│     └─ targets the scene selection pivot and forwards events to controller
└─ MovePanel (sidebar sibling)
   └─ receives the Scene-owned controller reference; reads pivot/bounds and
      invokes controller group operations
```

## Implementation outline (not authorized until approval)

1. Add `Selection.ts` with identity expansion, deterministic membership,
   pruning, and selection queries; add focused unit tests.
2. Add a scene context/controller that centralizes selection, a single gizmo,
   drag snapshots, pivot/bounds calculation, and group move/reset/drop
   operations.
3. Remove selection and move-specific state from `useSettingsStore`; replace
   legacy transform seed helpers with transform snapshots owned by the scene
   controller.
4. Simplify `GLVolumeMesh` to rendering and forwarding of hit/drag events;
   move the sole gizmo into `Scene`.
5. Refactor `MovePanel` to group-pivot semantics and maintain demand-mode
   invalidation after every imperative transform update.
6. Extend unit tests for membership expansion, additive toggling, both body and
   gizmo group deltas, bridge-synchronization consistency across sibling
   volumes, reset, and drop-to-bed. Extend Electron e2e coverage for selecting
   two instances, one gizmo only, gizmo axis drag, panel move, reset, and
   pre-slice synchronization.

## Confirmed design decisions

Confirmed 2026-08-18:

1. Default selection is complete-instance selection. Per-volume selection
   arrives later behind a modifier key.
2. Ctrl/Cmd-click toggles complete instances; Shift is reserved for box
   selection.
3. The move panel uses the aggregate pivot, with group drop-to-bed and
   per-instance reset semantics.
4. Gizmo grabbers take priority over body drag. A `DragControls` gesture is
   permitted only when no gizmo grabber owns the pointer.
5. Related interactive UI state—model meshes, aggregate selection pivot,
   gizmo, and dependent controls—must update in the same interaction turn.
   Do not defer one visual participant to a later React/frame update unless
   the user explicitly requests that behavior.

## Non-goals

- No C++ submodule changes or WASM bridge changes.
- No immediate synchronization while interacting.
- No part/volume mode, rectangle selection, keyboard shortcuts, rotate, scale,
  mirror, cut, snapping, undo/redo, or multi-plate behavior in this milestone.
- No change to the one-gizmo-at-a-time constraint; the refactor makes it an
  explicit scene invariant.

## Verification plan

- Unit: `Selection` expansion/toggle/prune, aggregate bounds, multi-instance
  delta, reset/drop, gesture exclusion, and exactly-one-gizmo state. Include
  a simulated grabber/mesh overlap and assert that the gizmo claims it while
  `DragControls` performs no body-drag update.
- Pre-slice synchronization unit: use two instances with two sibling volumes
  each and assert that the synchronization loop calls `setModelTransform` for
  every `(objectIdx, volumeIdx, instanceIdx)` composite. Client/mock tests
  verify the same fixture exposes independent per-volume bridge state.
- Electron e2e: select two loaded instances, confirm one gizmo, exercise a
  live multi-selection body drag and axis-handle drag, then slice and reload
  the persisted selection transforms. Include an axis-grabber press over
  model geometry and assert that the gizmo moves the selection without
  initiating body drag. Controller and pre-slice synchronization unit tests
  assert equal per-instance deltas, unchanged relative spacing, and every
  affected composite transform call.
- Run desktop unit tests, typecheck, and e2e suite after implementation.
