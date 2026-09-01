# Scene context menu: Add Handy models

**Date:** 2026-09-01
**Status:** Implemented
**Scope:** Make OrcaSlicer's bundled handy-model catalogue available from the
shared Prepare-scene context menu in both desktop and web hosts.

## Goal

The empty-scene right-click menu includes an **Add Handy models** submenu,
matching OrcaSlicer's current catalogue instead of exposing only the 3DBenchy
sample.

## Accepted behaviour

| Concern | Decision |
|---|---|
| Catalogue | Orca Cube, OrcaSliced Combo, Orca Badge, Orca Tolerance Test, 3DBenchy, Cali Cat, Autodesk FDM Test, Voron Cube, Stanford Bunny, and Orca String Hell — the current upstream `append_submenu_add_handy_model` entries, in its order. |
| Asset source | The shared-app resource manifest owns the catalogue and build staging. Its files remain only in the pinned `slicer-wasm` submodule; the shared-app staging script copies the selected `.drc`/`.3mf` files into each host's generated static output. They are fetched relative to the deployed application base, so desktop's loopback origin, a Web root deployment, and a Web subpath all work without host paths or network access. No duplicate model binaries are committed outside the submodule. |
| Import flow | Selecting an entry appends all of its source files through the existing typed runtime `addModel` operation, then applies the same result invalidation, selection reset, and model-loaded state update as normal Add Model and Add Primitive. Multi-file Orca Cube and OrcaSliced Combo therefore retain all their shipped components. |
| Availability | The submenu is disabled while slicing, exactly like Add Primitive and Add Model. A failed bundled-resource request or model import leaves the normal error status visible. |
| Deliberate parity boundary | Orca desktop's canvas-only auto-arrange helper for the two multi-file entries and String Hell's optional preset-edit dialog are not present in the shared first-release app. The shipped model data is imported unchanged; no temporary profile edits are made. |
| Mobile | Deferred. The existing desktop context menu is retained; no mobile interaction claim is introduced. |

## Verification

- Unit coverage verifies normal bundled import, multi-file import order, and
  resource-request failure behavior.
- Electron E2E opens the context-menu submenu, selects 3DBenchy, and confirms
  it adds a model through the existing scene pipeline.
- `pnpm test` and `pnpm typecheck` pass; the production Web and desktop builds
  confirm all 11 source files are staged for both static hosts.
