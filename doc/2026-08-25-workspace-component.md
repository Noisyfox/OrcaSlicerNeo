# 2026-08-25 — Workspace component (sidebar + 3D scene)

## Why

`AppShell` had grown two unrelated jobs: stacking the four app rows
(title bar / toolbar / content / status) and owning the whole sidebar↔scene
split — ~110 lines of drag, keyboard, and preference-persistence logic for a
divider that only concerns the middle row.

The scene interaction controller was split across the same seam from the other
side: `App` held the `sceneInteraction` state purely so it could hand the
controller to the sidebar (`ObjectList`, `SettingsPanel`) and the viewport,
which are siblings inside that middle row. Every controller change re-rendered
`App`, though nothing in `App`'s own render depends on it.

## What changed

- **New** `packages/slicer-app/src/components/workspace/Workspace.tsx`
  - Owns the sidebar width state, the resize separator (pointer/mouse/keyboard)
    and the `220px`–`560px` clamp + preference persistence — moved verbatim
    from `AppShell`, including the `data-testid="sidebar-resizer"` contract.
  - Owns the `SceneInteractionController` state and renders both halves that
    consume it: the sidebar (`ObjectList` + `SettingsPanel`) and `Viewport`.
  - Optional `onSceneInteractionChange` prop hands the controller upward.
- `packages/slicer-app/src/components/layout/AppShell.tsx`
  - Now a pure vertical stack (170 → 19 lines). The `settings` and `viewport`
    props collapse into one `workspace` node, which must stretch itself
    (`flex-1 min-h-0`).
- `packages/slicer-app/src/App.tsx`
  - Drops the `sceneInteraction` state and the three child imports; keeps a
    ref, fed by a stable `onSceneInteractionChange` callback, because the menu
    command dispatcher (`addModel`, `clearScene`) reads the controller lazily
    at dispatch time.

## Behavior

No user-visible change. Resize, persistence, scene selection, and the menu
commands that act on the controller all behave as before.

## Verification

- `pnpm typecheck`, `pnpm test` (282 unit tests, incl. the slicer-app
  import-direction guard) — pass.
- `pnpm --filter @orca/desktop test:e2e` — 17 passed, 2 skipped, 1 failed.
  The failure (`scene selection: rotate/scale gizmos, panels, coord toggle`,
  gizmo axis polls `null`) reproduces identically on the unmodified baseline
  and is **pre-existing**, not caused by this refactor.
- `apps/desktop/e2e/preferences-persistence.e2e.ts` — passes. It is not in the
  default `test:e2e` list but is the test that covers the moved resizer, so it
  was run explicitly.
- No WASM quick build: this change touches no C++, bridge, or build scaffold.
