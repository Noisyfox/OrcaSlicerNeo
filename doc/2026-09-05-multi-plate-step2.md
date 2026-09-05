# Multi-plate lifecycle — Step 2

Step 2 owns the runtime plate session in the WASM bridge. A session starts with
one empty plate and opaque plate IDs that remain stable while display indexes
compact. The bridge supports at most 36 plates, rejects deleting the sole
plate atomically, selects a newly added plate, and keeps the current plate
identity when deleting a non-current plate. Deleting the current plate selects
the plate compacted into its slot, or the preceding plate when the deleted
plate was last.

Plate membership is recomputed from native Orca instance convex-hull AABB
intersection. The lowest display-index intersecting plate wins ties. Membership
and full in-bounds validity are reported independently; instances with no
matching plate are unprintable, while deleted-plate instances are parked at
the final vacant grid position until a later editing/recompute operation.

Every successful add, select, delete, and recompute command returns one
snapshot. Mutations additionally return every instance world transform changed
by grid reflow. Reflow translates instances by the same plate delta, preserving
their plate-local coordinates. Grid origins and ordering follow Orca's native
column-count, gap, and unprintable-origin rules.

Validation covers the typed client and mock contract, direct serial/threaded
WASM mutation harnesses, bridge smoke, single-plate slicing, and project
round-trip behavior. React controls, UI grouping, persistence format changes,
slice jobs/results, auto-arrange, undo/redo, and per-plate settings remain out
of scope for this step.
