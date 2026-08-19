# Viewport renders on demand only

Date: 2026-08-16

## Rule

**The 3D view renderer must not render the next frame unless something
changed.** An idle viewport renders zero frames; the GPU/CPU cost of the
renderer is proportional to actual changes, never to elapsed time.

## Enforcement

- `Viewport.tsx` — `<Canvas frameloop="demand">`. react-three-fiber then
  renders a frame only when something invalidates it:
  - **Interaction / damping** — drei `OrbitControls` calls `gl.invalidate()`
    on every camera `change` event (and its `useFrame` update while damping),
    so orbit/dolly/pan animate smoothly and frames stop shortly after the
    pointer is released.
  - **Scene data changes** — model load, slice result arrival, layer
    scrubber selection: a React re-render of the scene graph invalidates
    the frame, so new data always appears.
  - **Resize** — r3f invalidates internally.

## Constraints on new viewport code

- No `useFrame`-based animation loops: a component that wants per-frame
  motion must call `state.invalidate()` explicitly (or drive a clock), never
  assume a continuous loop.
- Static data-driven meshes need no work: mounting/changing them invalidates
  automatically.
- **Imperative THREE-object mutations do not invalidate.** A re-render that
  produces identical JSX (stable object identity) commits nothing through the
  r3f reconciler, and pointer events do not invalidate either — e.g.
  `geometry.setDrawRange()` from a store subscription (the layer scrubber's
  visibility control in `ToolpathLines.tsx`) and
  `mesh.position.copy()` per drag step in `ModelMesh.tsx` both stay frozen
  until an explicit `useThree((s) => s.invalidate)()` after the mutation.
  e2e regression coverage: canvas-pixel assertions for the scrubber and the
  mid-drag move in `apps/desktop/e2e/app.e2e.ts`.
