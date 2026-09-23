# Object interaction performance

Date: 2026-09-23
Status: Implementation in progress
Scope: Shared settings panel and additive model publication in Electron and Web.

## Accepted behavior

Project settings do not depend on model selection or plate navigation. Scoped
settings follow the current target, including when switching from Project mode.
Search, expanded categories, field drafts, validation, reset, and Undo/Redo keep
their existing behavior. Unchanged fields avoid remounting or rerendering their
controls. Categories remain expanded by default; no virtualization is introduced.

Adding primitives, files, and handy models preserves existing renderer geometry
and BVHs. Only newly added objects request mesh buffers through the existing
typed scene-patch API. Structure, authoritative plate transforms, and mesh
publication remain ordered under the project mutation fence. Failed or obsolete
projections must not publish a partial scene. Full project replacement keeps its
existing full-load path.

Continuous-drag admission, transaction ordering, and history semantics are not
changed in this task. Mobile support remains deferred under the shared desktop
layout policy. Reduced renderer work benefits both supported hosts without
introducing host-specific behavior or additional persistent geometry caches.

## Verification scope

Cover Project selection independence, Scoped target switching and field edits,
search/reset semantics, retained geometry identity, consecutive adds, and
Add/Undo/Redo. Run package tests/typecheck per piece, root tests/typechecks at
handoff, and focused Electron interaction tests plus real-WASM timing probes.
No native ABI or WASM build changes are planned.
