# Configuration overlay precedence correction

**Date:** 2026-09-20

**Status:** Delivered

## Accepted behavior

When a plate is sliced, the effective native print configuration is composed
from the selected global/profile configuration and the Worker-owned project
overlay first, then the selected plate's configuration is applied last. A
plate-local value therefore overrides a project/global value for that plate,
matching OrcaSlicer's `BackgroundSlicingProcess::apply` composition.

Object and part `ModelConfig` values remain owned by the model and continue to
be resolved by `Print::apply` after the effective print configuration is
composed. No new UI scope or project toggle is introduced.

The same precedence is used by Prepare-side effective-configuration reads so
that preview projections and slicing observe one order. Overlay persistence,
history, plate input stamps, and affected-plate invalidation keep their
existing behavior; a rejected mutation remains atomic.

## Verification decision

Add a real bridge regression that sets conflicting project and plate values,
slices through the native boundary, verifies the plate value wins, and
round-trips the overlay through project save/load before checking the same
precedence again. Run the focused bridge harness for serial and threaded
artifacts plus the repository checks required for a shared WASM boundary.
