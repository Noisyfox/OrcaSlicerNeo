# Rotate Gizmo E2E Stability

**Date:** 2026-08-29
**Status:** Implemented
**Scope:** Desktop mock E2E rotate/scale gizmo coverage

## Problem

The rotate/scale gizmo E2E test targeted five fixed offsets near the selection
pivot when trying to hover the Z rotation ring. In the default perspective
camera, the invisible picker ring projects as a screen-space ellipse. Those
few points can instead hit a centre or Y-axis handle, so the test times out
waiting for the Z axis even though the product gizmo works.

## Resolution

The test projects the live selection pivot as before, then probes a set of
points around the observed ellipse perimeter. This keeps the assertion focused
on the Z rotation interaction without changing the renderer, picker geometry,
or timeouts.

## Verification

Run `pnpm --filter @orca/desktop test:e2e`. The rotate/scale gizmo test must
pass alongside the existing desktop suite; real-artifact-only cases remain
conditionally skipped when their artifacts are unavailable.
