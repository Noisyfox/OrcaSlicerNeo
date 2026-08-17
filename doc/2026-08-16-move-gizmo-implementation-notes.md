# M5 — Move Gizmo (implementation notes)

Date: 2026-08-16. Design: `doc/2026-08-16-move-gizmo-design.md`. Milestone:
`spec/Grand Plan.md` → "Milestone 5: Move Gizmo".

## Status

Delivered 2026-08-16 — commits `320561e..14f0d1e` on `feat/move-gizmo`
(nine commits; every task gated by its own review, the branch by the
final whole-branch review plus the fix-wave re-review). Merged to main
2026-08-16 (merge commit).

**Amendment (2026-08-17, post-merge):** the body drag no longer locks Z —
`axisLock="z"` dropped for a free drag in the camera-facing plane. See
"Free body drag" below.

## What shipped

- **Move gizmo** on selection: drei `TransformControls` (translate, world
  space) attached to the selected object's drag group — axis arrows +
  plane handles with Z lift (`MoveGizmo.tsx`).
- **Body drag** via drei `DragControls` (free — camera-facing plane, no
  axis lock; amended 2026-08-17, see "Free body drag") replacing the M2
  hand-rolled pointer drag (`ModelMesh.tsx`; the old pointer-drag
  machinery and `BED_Z` are deleted).
- **Move panel**: numeric X/Y/Z inputs, Drop to bed, Reset — committed
  through the bridge via `commitPosition`, with store + group revert on
  failure.
- **Store transform maps**: per-object `positions` / `initialPositions` /
  `objectMinZ` in the settings store, seeded on model load.
- **Shared commit path**: `commitPosition` bridge helper + pure
  `transformMath` helpers; the store→group subscription in `ModelMesh`
  moves the mesh visually on panel commits.
- **e2e**: gizmo axis drag, panel inputs, drop to bed, reset spec with the
  deterministic `__orcaE2e.gizmoAxis` engage hook (VITE_USE_MOCK-gated,
  no-op in production).

## Spike-lite verification (Task 5)

Task 5's spike-lite record confirmed the gizmo's orientation in Z-up (its
world axes derive from `space="world"` + camera up, exactly as the design
intends), axis-arrow drags, mutual exclusion between gizmo and body drags,
and orbit restore after a gesture. One deviation from the plan: the
optional manual dev-app run was skipped per the controller's ruling — the
same ground is covered by the e2e gate — so the record is the Task 5
spike-lite report plus the e2e assertions rather than a manual pass.

## Key mechanics discovered

- `DragControls` leaves `matrixAutoUpdate` false on the wrapped group (the
  r3f transform-from-position convention), so the move tool forces
  `matrixAutoUpdate = true` and disables drei's own transform write with
  `autoTransform={false}` — drags must be copied into the group + store
  explicitly.
- Mutual exclusion via `gestureRef` + `kind` state: r3f dispatches
  gizmo-handle presses to the mesh **behind** the gizmo, so the body drag
  must be told to stand down (`dragConfig.enabled = kind !== 'gizmo'`).
- drei auto-disables the makeDefault `OrbitControls` for body drags — no
  manual control needed on that path.
- The end-of-drag commit hooks to drei 10.7.8's forwarded `onMouseUp` (the
  controls' `mouseUp` event) with a `kind === 'gizmo'` guard — a zero-delta
  handle-tap commit is idempotent; body/background presses skip (body drags
  commit via `DragControls`); a mid-gesture deselect already resets `kind`
  (correct abort). `onMouseDown`/`onObjectChange` keep their semantics.
- History: the original design attached a `'dragging-changed'` listener via
  the controls instance ref. That event DOES exist in three-stdlib 2.36.1 —
  it is dispatched through the `defineProperty('dragging')` accessor
  setter, and the type string is built dynamically, so a literal-string
  grep misses it; it would have fired on release. The final review's
  grep-based C1 was a false positive. The `mouseUp` hook is kept anyway:
  it is dispatched unconditionally on handle release, independent of the
  `dragging` setter path, and the reload round-trip e2e assertion now
  proves the bridge write end-to-end — closing the verification gap that
  let the false positive look real.
- Demand rendering (`frameloop="demand"`): imperative THREE mutations need
  `invalidate()`. drei `DragControls` invalidates internally; drei
  `TransformControls` does NOT — the move tool calls `invalidate()` from
  `onObjectChange`.
- The store→group subscription in `ModelMesh` means panel commits move the
  mesh visually (asserted by pixel diff in e2e).

## Free body drag (2026-08-17 amendment)

The approved design's body drag locked Z (`axisLock="z"` — the drag plane
was world-XY at the object's current height, so an object lifted by the Z
arrow stayed lifted; see the design doc's Key Decisions). After the merge,
the lock was dropped: with no `axisLock`, drei computes the drag plane
perpendicular to the camera through the grab point (`camera.getWorldDirection`
negated, source-verified in the installed drei 10.7.8), so dragging a
body moves the object freely in X, Y and Z with the pointer — an angled
view lifts or lowers it directly. Drop to bed remains the snap-back.

No test changes were needed: the e2e move-gizmo spec exercises the gizmo
arrows, panel inputs and Drop to bed — none asserts a Z-locked body drag —
and the unit suites never touched the drag plane. The change is
`ModelMesh.tsx` (drop `axisLock="z"` + comment) and this doc set.

## Verification

- `pnpm --filter desktop test`: 6 files, 18/18 passed.
- `pnpm --filter desktop typecheck`: clean (exit 0).
- `pnpm --filter desktop test:e2e`: 3 passed + 1 skipped (the
  `slice-error` skip is `test.skip(!REAL)` in mock builds — static, not
  related to this milestone). Final run performed in this task; prior
  identical runs in the Task 7 report (9 consecutive green full-suite
  runs after the flake hardening).
- **e2e iteration notes (Task 7):** the select click targets the projected
  centroid `project([10,10,10])` — the mock cube spans [0,20]³, so a
  canvas-center click misses it by ~20 px; the X-arrow drag ends at world
  +55 because three-stdlib's TransformControls translates by pointer
  **delta**, not to the pointer's world position (grab at +10, end at +55
  → commit 45.000 exactly); and the ~1-in-13 hover-poll flake (a garbage
  commit from a missed picker — body drag + orbit ran while the TC
  `axis` was null) was fixed deterministically: `MoveGizmo` exposes the TC
  `axis` via the VITE_USE_MOCK-gated `__orcaE2e.gizmoAxis` hook and the
  test polls `axis === 'X'` before pressing. No flake has reappeared since
  the fix (6/6 + 3/3 full-suite runs).

## Deferred

Flip buttons, snap/grid, multi-select, keyboard shortcuts, and
multi-instance support (the move tool operates on instance 0 only).

## Files touched

- `apps/desktop/src/renderer/src/components/viewport/gizmo/{MoveGizmo.tsx,
  commitPosition.ts, commitPosition.test.ts}` (created)
- `apps/desktop/src/renderer/src/components/viewport/{ModelMesh.tsx,
  Scene.tsx, useModelLoader.ts, transformMath.ts, transformMath.test.ts}`
- `apps/desktop/src/renderer/src/components/settings/{MovePanel.tsx,
  SettingsPanel.tsx}`
- `apps/desktop/src/renderer/src/stores/useSettingsStore.ts` (+ test),
  `apps/desktop/src/renderer/src/lib/vec3.ts`
- `apps/desktop/e2e/app.e2e.ts`

Renderer-only milestone; no bridge/WASM changes. Submodule
`packages/slicer-wasm/cpp` untouched.
