# Move Gizmo Design

Date: 2026-08-16
Status: Approved (brainstorming session, 2026-08-16); amended 2026-08-17 —
body drag dropped the Z lock (see "Amendments" at the end)
Scope: Milestone 5 — full move tool for the 3D viewport, replacing the M2
"basic move-on-plate" drag.

## Summary

Replace the hand-rolled drag-move in `ModelMesh.tsx` with the full OrcaSlicer
move tool:

- **Gizmo**: drei `TransformControls` (mode `translate`, world space) attached
  to the selected object — axis arrows (X red / Y green / Z blue) with
  plane handles, built-in hover highlight and camera-distance scaling. The Z
  arrow lifts the model off the bed for the first time.
- **Body drag**: drei `DragControls` replaces the manual pointer handlers
  (plane math, pointer capture, manual orbit-disable, manual `invalidate`).
  Drag on a selected object's body moves it freely — no axis lock; the
  drag plane is perpendicular to the camera through the grab point, so X,
  Y and Z all follow the pointer (amended 2026-08-17: the original
  `axisLock="z"` world-XY plane locked Z and was dropped).
- **Move panel**: sidebar section (visible when an object is selected) with
  numeric X/Y/Z position inputs, **Drop to bed**, and **Reset**.

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Gizmo tech | **drei `TransformControls`** (not a custom R3F gizmo) | User choice; battle-tested drag math, built-in hover/size behaviors; three.js default colors already match OrcaSlicer's X/Y/Z convention |
| Body drag | **drei `DragControls`** (replaces hand-rolled handlers) | User choice; deletes ~40 lines of manual gesture code (see the demand-render doc's constraints) |
| Tool model | `tool: 'move'` field in the settings store; **gizmo-on-selection**; no toolbar buttons | Reserved for rotate/scale milestones; zero UI churn now |
| Transform ownership | The **DragControls group** is the single transform owner; both drag systems write `group.position` | One commit path, one source of truth |
| Store shape | `positions` / `initialPositions` per-object maps **replace** the `instanceOffset` tuple (no readers today) | Panel needs the selected object's offset; survives selection changes and multi-object models |
| Body-drag plane | Free — camera-facing plane, no axis lock (amended 2026-08-17; was `axisLock="z"` world-XY) | A locked plane meant dragging the body could never lift or lower an object; the free drag moves X/Y/Z with the pointer |
| Panel location | Sidebar section in `SettingsPanel` (appears when `selectedObject != null`) | Existing layout; OrcaSlicer puts gizmo options in its own panel |
| Deferred | Flip buttons, snap/grid, multi-select, keyboard shortcuts; instance 0 only | Flip is a scale-gizmo concern (`orc_set_instance_offset` has no scale axis); multi-instance is M5+ |

## Architecture

```
ModelMesh (per object)
├─ <DragControls ref={groupRef} autoTransform={false}
│    onDrag={pos → groupRef.position.copy(pos) → store live}
│    onDragStart/onDragEnd={gesture gate + commit}>
│  └─ <mesh onClick={select}/>            ← body drag: free (camera plane)
└─ selected && <TransformControls object={groupRef.current}
     mode="translate" space="world"
     enabled={gesture !== 'body'}
     onMouseDown / onDraggingChanged={gesture gate + commit} />

Scene
└─ useModelLoader → store: positions / initialPositions / objectMinZ

SettingsPanel
└─ MovePanel (selectedObject != null)
   ├─ X / Y / Z numeric inputs (store positions[selected])
   ├─ Drop to bed
   └─ Reset
```

### Component files

- `apps/desktop/src/renderer/src/components/viewport/ModelMesh.tsx` —
  refactored: DragControls wrapper + conditional TransformControls.
- `apps/desktop/src/renderer/src/components/viewport/gizmo/MoveGizmo.tsx` —
  the TransformControls wrapper (gesture gating, commit, orbit disable) so
  rotate/scale gizmos later slot in beside it.
- `apps/desktop/src/renderer/src/components/viewport/useModelLoader.ts` —
  computes bounding boxes; seeds `positions` / `initialPositions` /
  `objectMinZ` in the store.
- `apps/desktop/src/renderer/src/components/settings/MovePanel.tsx` —
  numeric inputs + Drop to bed + Reset.
- `apps/desktop/src/renderer/src/stores/useSettingsStore.ts` — store changes.

## Store changes (`useSettingsStore`)

- Add `tool: 'move'` (reserved; gizmo shows on selection; no selector UI).
- Remove `instanceOffset: [n,n,n]` + `setInstanceOffset` (no readers — the
  only writer is ModelMesh's old `endDrag`, its own store unit test being
  the sole other consumer; grep-verified).
- Add:
  - `positions: Record<objectIdx, [x, y, z]>` — current offsets; seeded at
    load from `ModelObjectBuffer.offset`; updated live during drags and on
    commit. The MovePanel reads `positions[selectedObject]`.
  - `initialPositions: Record<objectIdx, [x, y, z]>` — for Reset.
  - `objectMinZ: Record<objectIdx, number>` — local bbox min Z (from
    `geometry.computeBoundingBox()` in `useModelLoader`) for Drop to bed:
    `newZ = -minZ` (world min Z = offset.z + minZ → set world min Z = 0).

## Interaction

### DragControls mechanics (drei 10.7.8 source-verified)

- drei's group has `matrixAutoUpdate: false`; with `autoTransform` it writes
  the group matrix directly, which would make TransformControls' `position`
  writes invisible. Fix: `autoTransform={false}`; in `onDrag`, copy the
  intended position from the passed `localMatrix` onto `group.position`; a
  mount effect sets `group.matrixAutoUpdate = true` and seeds
  `group.position` from `buffer.offset`. No type hacks (drei's
  `DragControlsProps` doesn't type `position`/`matrixAutoUpdate`).
- drei auto-disables the makeDefault OrbitControls on drag start and calls
  `invalidate()` per drag step — the demand-render constraint is satisfied
  without manual wiring.
- `filterTaps: true, threshold: 1` (drei defaults) keep click-to-select
  working — taps don't drag.

### Mutual exclusion (handle press would otherwise start both gestures)

A press on a gizmo handle hits the model mesh behind it in r3f's dispatch,
so DragControls and TransformControls would both translate. Gate with a
synchronous `gestureRef: { kind: 'none' | 'body' | 'gizmo', dragStartPos:
Vector3 }` (drag-start position captured for commit-failure revert):

- TC `onMouseDown` (handle press) → `gestureRef = 'gizmo'` → `dragConfig
  enabled: false` + `if (gestureRef.current !== 'body') return` guard in
  `onDrag` (covers the pre-render race; position writes happen only in
  onDrag).
- TC `enabled={gesture !== 'body'}` prevents gizmo hover/drag during body
  drags.
- TC `onDraggingChanged` (true → set gesture; false → reset + commit).
- OrbitControls disabled during gizmo drags (existing pattern), restored on
  drag end.

### Commit

Shared `commit()` (both gestures, on release):

1. `pos = groupRef.current.position`
2. `slicerClient.setInstanceOffset(objectIdx, 0, x, y, z)`
3. ok → `positions[objectIdx] = pos`
4. failure → revert `group.position` to the position **captured at drag
   start** (`gestureRef.dragStartPos` — the store's `positions` is live
   during the drag, so it no longer holds the pre-drag value at commit
   time), surface error via the existing status-bar error path.

### Gizmo/Z-up risk

TransformControls with `camera.up = [0, 0, 1]` (slicer Z-up) and
`space="world"`: handles should align to world axes; camera only affects
screen-space scaling. **Verify first** in a spike-lite step (mount TC on a
dummy object; confirm arrow orientation + axis drags + that use-gesture
picks up dynamic `dragConfig.enabled`).

## Scope decisions

- Gizmo stays active over slice-result overlays (v1; preview-mode behavior
  is a later refinement).
- Instance 0 only (bridge `setInstanceOffset(objIdx, 0, …)`); multi-instance
  is M5+.
- No keyboard shortcuts, no snap, no multi-select.
- Flip buttons deferred (scale axis doesn't exist in the bridge).

## Testing

- **Unit (vitest)**:
  - Store: `positions`/`initialPositions`/`objectMinZ` seed + update; commit
    failure reverts.
  - MovePanel: input validation (bad number → revert to store value),
    Drop-to-bed math (`z = -minZ`), Reset.
  - Mock-client: `setInstanceOffset` called with the group position on
    commit.
- **e2e (Playwright, existing canvas-pixel pattern in `app.e2e.ts`)**:
  - Existing drag test must still pass; the click-at-center may now land on
    TC's center box instead of the body — both change pixels, so assertions
    survive; adjust drag start point if any post-release offset assertion
    breaks.
  - New: select → gizmo appears (pixel diff); X-arrow drag commits the
    expected offset (mock); numeric input change moves the mesh; Drop to
    bed; Reset.
- **Typecheck** (CI).
- **Spike-lite step 1** (first implementation step): TC `object` prop +
  Z-up camera orientation; drei DragControls `dragConfig.enabled` dynamic
  toggle; TC + DragControls mutual exclusion on a handle press.

## Risks

| Risk | Mitigation |
|---|---|
| TC + Z-up camera quirk (gizmo misorientation) | Spike-lite step 1 before building the rest; fallback: `camera.up` override or custom handle rotation |
| use-gesture config staleness (`dragConfig.enabled`) | Verify in spike-lite; fallback: guard in `onDrag` (already present) + conditional render |
| Handle press starts both gestures | `gestureRef` gate + onDrag guard (designed above) |
| drei version drift (10.7.8 pinned) | Source-verified against the installed copy; version pinned in pnpm lockfile |
| Existing e2e drag test semantics change | Reviewed in the e2e work item |

## Docs & plan updates

- `doc/high_level_dev_plan.md` — new Milestone 5 "Move Gizmo" entry.
- `spec/Grand Plan.md` — Milestone 5 section; partial credit on the M5+
  "Gizmos: rotate/scale/cut/measure/arrange/orient" line.
- Implementation notes: `doc/2026-08-16-move-gizmo-implementation-notes.md`
  on delivery.

## Amendments

### 2026-08-17 — body drag no longer locks Z

The body drag dropped `axisLock="z"`. With no lock, drei computes the drag
plane perpendicular to the camera through the grab point, so dragging an
object's body moves it freely in X, Y and Z with the pointer (the locked
world-XY plane kept an object at its current height — it could never be
lifted or lowered by body drag). Z lift now comes from the free drag, the
Z arrow, and the move panel alike. Decided after the milestone merged to
main; see the implementation notes' amendment section.
