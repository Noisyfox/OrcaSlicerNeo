# Viewport flash on second model add

Date: 2026-08-18
Status: Implemented
Scope: renderer viewport model loader

## Bug

Adding a second model to a non-empty scene made the whole viewport flash
once: every mesh disappeared and reappeared a moment later.

## Root cause

`useModelLoader` refetches the complete volume collection on every
`modelRevision` bump (`useModelLoader.ts`). Its effect cleanup — which
clears and disposes the mounted geometries — was written for component
unmount, but React runs it on **every** re-run of the effect. So on a
revision change the cleanup blanked the scene first, and the meshes only
returned once the async `getModelMesh()` worker round-trip resolved.

## Fix

- The revision effect's cleanup now only cancels the in-flight fetch
  (`disposed = true`); it no longer touches the rendered objects.
- The previous volumes stay mounted while the reload is in flight;
  `glVolumeCollection.replace()` + `setObjects(loaded)` swap the whole
  collection in one render (the old geometries are disposed at the swap,
  not before).
- A separate empty-deps effect handles genuine Canvas teardown by
  disposing the mounted geometries.

## Verification

- Desktop unit tests and typecheck pass.
- Manual: add a model, then add a second — the scene stays visible
  throughout; only the collection swap occurs.
