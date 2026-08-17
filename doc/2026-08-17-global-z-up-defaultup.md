# Global Z-up via THREE.Object3D.DefaultUp (experiment)

Date: 2026-08-17
Branch: `feat/global-z-up`

## What

Replace the piecemeal per-camera Z-up wiring with a global one:
`THREE.Object3D.DEFAULT_UP = new THREE.Vector3(0, 0, 1)` in the renderer
entry ([main.tsx](../apps/desktop/src/renderer/src/main.tsx)), before the
Canvas mounts. `DEFAULT_UP` (renamed from the older `DefaultUp` in r185) is
the up vector every `Object3D` — cameras included — is born with, so nothing
downstream needs to remember the convention.

Changes:

- `main.tsx` — module-scope assignment, guarded by a comment that it must
  stay ahead of any `Object3D` construction (objects created at import time
  would keep the three.js Y-up default).
- `Viewport.tsx` — dropped `up: [0, 0, 1]` from the Canvas camera prop; it is
  now inherited at construction. Comment updated.

## Mechanism (verified against installed sources)

- fiber 9.7.0 `createRoot`: the default camera is `new PerspectiveCamera(...)`
  (up inherited from `DefaultUp`), then `applyProps(camera, cameraOptions)`
  applies position/fov, then `camera.lookAt(0, 0, 0)` — and
  `Object3D.lookAt` uses `this.up`. Same orientation as the old code, which
  applied the `up` prop before `lookAt` ran.
- three-stdlib OrbitControls (r185): orbit axis comes from `camera.up` —
  unchanged, since the camera's up is now Z at construction.
- drei 10.7.8 `GizmoHelper` tween: saves `mainCamera.up` at mount
  (`defaultUp.current.copy(mainCamera.up)` → now `(0,0,1)` automatically)
  and restores it when the tween completes. No Y-up assumptions anywhere in
  the face-click tween.
- drei `TransformControls` is used in translate mode only — no `camera.up`
  involvement in that mode.
- drei's Hud portal camera (GizmoHelper) also inherits Z-up; the viewcube's
  orientation is driven by the main camera's quaternion, so nothing changes.

## Why this is the right shape

One line sets the convention for every future camera/Object3D in the app
(second window, screenshot camera, offscreen renders, ...) instead of each
site remembering `up: [0, 0, 1]`. Cost: it is a global, module-scope side
effect — must live in the renderer entry and be documented there (done in
the comment).

## Manual verification (dev)

`pnpm --filter desktop dev`, with a model loaded:

1. Initial view reads the convention: X right, Y into screen, Z up, bed
   plate horizontal.
2. Orbit (left drag) stays level about Z; pan/dolly unchanged.
3. Viewcube clicks still snap to axis-aligned views and end Z-up (the
   GizmoHelper tween restores `camera.up`, which is Z by default now).
4. Move gizmo translate drags work on all three axes and commit.

## Rollback

Revert the branch: `git checkout main && git branch -D feat/global-z-up` (or
revert the `main.tsx` / `Viewport.tsx` hunks — the old per-camera `up` prop
is the fallback).
