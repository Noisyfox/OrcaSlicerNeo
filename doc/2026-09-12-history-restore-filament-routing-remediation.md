# History Restore Filament Routing Remediation

Date: 2026-09-12
Status: Verified
Scope: Ensure an ordinary model move Undo in a new project restores a
filament-session projection that the typed client can render.

## Accepted behavior

- New project -> add Cube -> move Cube -> Undo restores the added-Cube frame.
- The restored filament snapshot contains only valid non-zero object and
  model-part routing identities, so the Prepare filament list remains usable.
- Restore still uses the Worker-owned archive history path; no UI error is
  suppressed or converted into a fallback projection.

## Root cause and decision

The upstream `ModelVolume` undo archive intentionally deserializes with an
invalid `ObjectID`. The Neo history adapter already materialized decoded
instances, but left decoded volumes in the fresh restored `ModelObject`.
Filament routing projects model-part IDs, so the restored snapshot emitted ID
zero and the typed client correctly rejected it as invalid routing.

The adapter now retains ordered volume IDs alongside each mutable object,
re-materializes decoded volumes into regular `ModelObject::add_volume`
allocations, and then loads both the archived volume state and saved base ID.
This preserves mutable volume data, retained-mesh references, and stable
runtime identity.

## Verification

`history-smoke.mjs` contains a real-WASM regression for the exact new-project
add/move/Undo sequence and asserts that the post-Undo routing projection is
valid for both object and model-part entries, while retaining the part ID.
