# M5 — Move Gizmo (implementation notes)

Date: 2026-08-16. Design: `doc/2026-08-16-move-gizmo-design.md`. Milestone:
`spec/Grand Plan.md` → "Milestone 5: Move Gizmo".

## Status

Delivered 2026-08-16 — commits `320561e..64ef977` on `feat/move-gizmo`
(eight commits across tasks 1-7, each reviewed; this task adds the
milestone docs and the final gate sweep).

## What shipped

- **Move gizmo** on selection: drei `TransformControls` (translate, world
  space) attached to the selected object's drag group — axis arrows +
  plane handles with Z lift (`MoveGizmo.tsx`).
- **Body drag** via drei `DragControls` (`axisLock="z"` — world-XY at the
  object's current height) replacing the M2 hand-rolled pointer drag
  (`ModelMesh.tsx`; the old pointer-drag machinery and `BED_Z` are
  deleted).
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
- `onDraggingChanged` is **not** a drei prop in 10.7.8 — drei's wrapper
  never forwards it (the Task 5 report documents this with type + runtime
  evidence); the listener attaches to the controls instance via drei's
  forwarded ref (`'dragging-changed'` event). `onMouseDown`/`onMouseUp`/
  `onObjectChange` props are supported and keep their semantics.
- Demand rendering (`frameloop="demand"`): imperative THREE mutations need
  `invalidate()`. drei `DragControls` invalidates internally; drei
  `TransformControls` does NOT — the move tool calls `invalidate()` from
  `onObjectChange`.
- The store→group subscription in `ModelMesh` means panel commits move the
  mesh visually (asserted by pixel diff in e2e).

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
